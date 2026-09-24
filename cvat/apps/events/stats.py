# Copyright (C) CVAT.ai Corporation
#
# SPDX-License-Identifier: MIT

from datetime import datetime, timedelta, timezone
from collections import Counter, defaultdict
from typing import Any

import clickhouse_connect
from dateutil import parser
from django.conf import settings
from rest_framework import serializers

from cvat.apps.engine.log import ServerLogManager

slogger = ServerLogManager(__name__)

CREATE_SCOPES = ("create:shapes", "create:tags", "create:tracks")
WORKING_TIME_SCOPE = "send:working_time"
SCOPE_TO_FIELD = {
    "create:shapes": "shapes",
    "create:tags": "tags",
    "create:tracks": "tracks",
}
KIND_FIELDS = ("manual", "ai", "imported", "other")


def _as_int(value: Any) -> int | None:
    if value in (None, "", "None", "null"):
        return None
    return int(value)


def _parse_bounds(query_params: dict[str, Any]) -> tuple[datetime, datetime]:
    raw_from = query_params.get("from")
    raw_to = query_params.get("to")
    now = datetime.now(timezone.utc)

    try:
        dt_from = parser.isoparse(raw_from) if raw_from else now - timedelta(days=30)
        dt_to = parser.isoparse(raw_to) if raw_to else now
    except parser.ParserError as exc:
        raise serializers.ValidationError(f"Cannot parse datetime parameter: {exc}") from exc

    if dt_from.tzinfo is None:
        dt_from = dt_from.replace(tzinfo=timezone.utc)
    if dt_to.tzinfo is None:
        dt_to = dt_to.replace(tzinfo=timezone.utc)

    if dt_from > dt_to:
        raise serializers.ValidationError("'from' must be before than 'to'")

    return dt_from, dt_to


def _clickhouse_client():
    clickhouse_settings = settings.CLICKHOUSE["events"]
    return clickhouse_connect.get_client(
        host=clickhouse_settings["HOST"],
        database=clickhouse_settings["NAME"],
        port=clickhouse_settings["PORT"],
        username=clickhouse_settings["USER"],
        password=clickhouse_settings["PASSWORD"],
        tz_mode="schema",
    )


def _common_filters(query_params: dict[str, Any], dt_from: datetime, dt_to: datetime):
    conditions = [
        "user_id IS NOT NULL",
        "timestamp >= {from:DateTime64}",
        "timestamp <= {to:DateTime64}",
    ]
    parameters: dict[str, Any] = {
        "from": dt_from,
        "to": dt_to,
    }

    org_id = _as_int(query_params.get("org_id"))
    user_id = _as_int(query_params.get("user_id"))
    project_id = _as_int(query_params.get("project_id"))
    task_id = _as_int(query_params.get("task_id"))

    if org_id is not None:
        conditions.append("org_id = {org_id:UInt64}")
        parameters["org_id"] = org_id
    if user_id is not None:
        conditions.append("user_id = {user_id:UInt64}")
        parameters["user_id"] = user_id
    if project_id is not None:
        conditions.append("project_id = {project_id:UInt64}")
        parameters["project_id"] = project_id
    if task_id is not None:
        conditions.append("task_id = {task_id:UInt64}")
        parameters["task_id"] = task_id

    return " AND ".join(conditions), parameters


def _annotation_kind(source: str | None) -> str:
    value = (source or "").strip().lower()
    if value == "auto":
        return "ai"
    if value == "file":
        return "imported"
    if value in ("manual", "semi-auto"):
        return "manual"
    return "other"


def _empty_kind_counts() -> dict[str, int]:
    return {field: 0 for field in KIND_FIELDS}


def _load_db_sources() -> dict[str, dict[int, str]]:
    try:
        from cvat.apps.engine.models import LabeledImage, LabeledShape, LabeledTrack

        return {
            "create:shapes": dict(LabeledShape.objects.values_list("id", "source")),
            "create:tags": dict(LabeledImage.objects.values_list("id", "source")),
            "create:tracks": dict(LabeledTrack.objects.values_list("id", "source")),
        }
    except Exception:
        slogger.glob.exception("Failed to load annotation sources for statistics")
        return {
            "create:shapes": {},
            "create:tags": {},
            "create:tracks": {},
        }


def empty_statistics(dt_from: datetime, dt_to: datetime, message: str | None = None) -> dict:
    payload = {
        "available": not bool(message),
        "from": dt_from.isoformat(),
        "to": dt_to.isoformat(),
        "users": [],
        "tasks": [],
        "daily": [],
        "totals": {
            "annotations": 0,
            "manual": 0,
            "ai": 0,
            "imported": 0,
            "other": 0,
            "users": 0,
            "working_ms": 0,
        },
    }
    if message:
        payload["message"] = message
        payload["available"] = False
    return payload


def _blank_row(row_id: int, name: str) -> dict:
    row = {
        "id": row_id,
        "name": name,
        "shapes": 0,
        "tags": 0,
        "tracks": 0,
        "working_ms": 0,
        **_empty_kind_counts(),
    }
    return row


def _finalize_rows(rows: list[dict]) -> list[dict]:
    for item in rows:
        item["annotations"] = sum(item[field] for field in KIND_FIELDS)
    return sorted(
        rows,
        key=lambda item: (item["manual"], item["annotations"]),
        reverse=True,
    )


def query_annotation_statistics(query_params: dict[str, Any]) -> dict:
    dt_from, dt_to = _parse_bounds(query_params)
    where_sql, parameters = _common_filters(query_params, dt_from, dt_to)

    try:
        with _clickhouse_client() as client:
            by_item = client.query(
                f"""
                SELECT user_id, user_name, task_id, scope,
                       toDate(timestamp) AS day,
                       timestamp,
                       JSONExtractUInt(item, 'id') AS obj_id,
                       nullIf(JSONExtractString(item, 'source'), '') AS obj_source
                FROM events
                ARRAY JOIN JSONExtractArrayRaw(
                    ifNull(payload, ''),
                    if(scope = 'create:shapes', 'shapes',
                       if(scope = 'create:tags', 'tags', 'tracks'))
                ) AS item
                WHERE scope IN ('create:shapes', 'create:tags', 'create:tracks')
                  AND {where_sql}
                """,
                parameters=parameters,
            )
            working = client.query(
                f"""
                SELECT user_id, any(user_name) AS user_name,
                       sum(if(duration > 0, duration, JSONExtractUInt(ifNull(payload, ''), 'working_time'))) AS working_ms
                FROM events
                WHERE scope = '{WORKING_TIME_SCOPE}'
                  AND {where_sql}
                GROUP BY user_id
                """,
                parameters=parameters,
            )
            working_task = client.query(
                f"""
                SELECT task_id,
                       sum(if(duration > 0, duration, JSONExtractUInt(ifNull(payload, ''), 'working_time'))) AS working_ms
                FROM events
                WHERE scope = '{WORKING_TIME_SCOPE}'
                  AND task_id IS NOT NULL
                  AND {where_sql}
                GROUP BY task_id
                """,
                parameters=parameters,
            )
    except Exception:
        slogger.glob.exception("Failed to query annotation statistics from ClickHouse")
        return empty_statistics(
            dt_from,
            dt_to,
            "Events database is unavailable. Annotation statistics cannot be loaded.",
        )

    db_sources = _load_db_sources()
    users: dict[int, dict] = {}
    task_rows: dict[int, dict] = {}
    daily_counts: dict[str, dict[str, int]] = {}

    def ensure_user(user_id: int, user_name: str | None) -> dict:
        if user_id not in users:
            users[user_id] = _blank_row(user_id, user_name or f"user-{user_id}")
        elif user_name and users[user_id]["name"].startswith("user-"):
            users[user_id]["name"] = user_name
        return users[user_id]

    def ensure_task(task_id: int) -> dict:
        if task_id not in task_rows:
            task_rows[task_id] = _blank_row(task_id, f"task-{task_id}")
        return task_rows[task_id]

    batches: dict[tuple, list[str | None]] = defaultdict(list)
    batch_meta: dict[tuple, tuple] = {}

    for user_id, user_name, raw_task_id, scope, day, timestamp, obj_id, obj_source in by_item.result_rows:
        source = obj_source
        if not source and obj_id:
            source = db_sources.get(scope, {}).get(int(obj_id))
        kind = _annotation_kind(source) if source else None
        key = (int(user_id), str(timestamp), scope, raw_task_id)
        batches[key].append(kind)
        batch_meta[key] = (int(user_id), user_name, raw_task_id, scope, str(day))

    for key, kinds in batches.items():
        known = [kind for kind in kinds if kind is not None]
        fallback = Counter(known).most_common(1)[0][0] if known else "other"
        user_id, user_name, raw_task_id, scope, day_key = batch_meta[key]
        row = ensure_user(user_id, user_name)
        field = SCOPE_TO_FIELD.get(scope)
        for kind in kinds:
            resolved = kind or fallback
            row[resolved] += 1
            if field:
                row[field] += 1
            day_row = daily_counts.setdefault(day_key, _empty_kind_counts())
            day_row[resolved] += 1
            if raw_task_id not in (None, ""):
                task_row = ensure_task(int(raw_task_id))
                task_row[resolved] += 1
                if field:
                    task_row[field] += 1

    for user_id, user_name, working_ms in working.result_rows:
        row = ensure_user(int(user_id), user_name)
        row["working_ms"] = int(working_ms or 0)

    for raw_task_id, working_ms in working_task.result_rows:
        if raw_task_id in (None, ""):
            continue
        row = ensure_task(int(raw_task_id))
        row["working_ms"] = int(working_ms or 0)

    if task_rows:
        try:
            from cvat.apps.engine.models import Task

            names = dict(
                Task.objects.filter(pk__in=list(task_rows)).values_list("id", "name")
            )
            for tid, name in names.items():
                if name:
                    task_rows[tid]["name"] = name
        except Exception:
            slogger.glob.exception("Failed to resolve task names for annotation statistics")

    user_list = _finalize_rows(list(users.values()))
    task_list = _finalize_rows(list(task_rows.values()))[:100]
    daily_list = [
        {"date": day, "count": sum(counts.values()), **counts}
        for day, counts in sorted(daily_counts.items())
    ]

    totals = _empty_kind_counts()
    for item in user_list:
        for field in KIND_FIELDS:
            totals[field] += item[field]

    return {
        "available": True,
        "from": dt_from.isoformat(),
        "to": dt_to.isoformat(),
        "users": user_list,
        "tasks": task_list,
        "daily": daily_list,
        "totals": {
            **totals,
            "annotations": sum(totals.values()),
            "users": len(user_list),
            "working_ms": sum(item["working_ms"] for item in user_list),
        },
    }
