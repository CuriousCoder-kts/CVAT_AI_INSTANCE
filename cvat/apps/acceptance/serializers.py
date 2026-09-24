from __future__ import annotations

from rest_framework import serializers

from cvat.apps.engine.serializers import BasicUserSerializer

from .models import (
    AcceptanceActionType,
    AcceptanceAnnotationSnapshot,
    AcceptanceRecord,
    AcceptanceRecordStatus,
    SnapshotType,
)


class AcceptanceSnapshotReadSerializer(serializers.ModelSerializer):
    class Meta:
        model = AcceptanceAnnotationSnapshot
        fields = ("id", "snapshot_type", "data", "created_date", "updated_date")
        read_only_fields = fields


class AcceptanceSnapshotWriteSerializer(serializers.ModelSerializer):
    class Meta:
        model = AcceptanceAnnotationSnapshot
        fields = ("snapshot_type", "data")

    def to_representation(self, instance):
        serializer = AcceptanceSnapshotReadSerializer(instance, context=self.context)
        return serializer.data


class AcceptanceRecordListSerializer(serializers.ModelSerializer):
    """Lightweight list row — no heavy snapshot payloads."""

    reviewer = BasicUserSerializer(allow_null=True, required=False)
    task_id = serializers.IntegerField(source="get_task_id", read_only=True)
    task_name = serializers.CharField(source="get_task_name", read_only=True)
    project_id = serializers.IntegerField(source="get_project_id", read_only=True, allow_null=True)
    has_before_snapshot = serializers.SerializerMethodField()
    has_after_snapshot = serializers.SerializerMethodField()
    frame_count = serializers.SerializerMethodField()
    frames = serializers.SerializerMethodField()

    class Meta:
        model = AcceptanceRecord
        fields = (
            "id",
            "job",
            "task_id",
            "task_name",
            "project_id",
            "frame",
            "frame_count",
            "frames",
            "reviewer",
            "action_type",
            "description",
            "status",
            "shape_count_before",
            "shape_count_after",
            "tag_count_before",
            "tag_count_after",
            "track_count_before",
            "track_count_after",
            "has_before_snapshot",
            "has_after_snapshot",
            "created_date",
            "updated_date",
        )
        read_only_fields = fields

    def _before_data(self, obj: AcceptanceRecord) -> dict:
        for snap in obj.snapshots.all():
            if snap.snapshot_type == SnapshotType.BEFORE:
                return snap.data if isinstance(snap.data, dict) else {}
        return {}

    def get_has_before_snapshot(self, obj: AcceptanceRecord) -> bool:
        return any(s.snapshot_type == SnapshotType.BEFORE for s in obj.snapshots.all())

    def get_has_after_snapshot(self, obj: AcceptanceRecord) -> bool:
        return any(s.snapshot_type == SnapshotType.AFTER for s in obj.snapshots.all())

    def get_frames(self, obj: AcceptanceRecord) -> list[int]:
        data = self._before_data(obj)
        if data.get("version") == "session-v1" and isinstance(data.get("frames"), dict):
            frames = sorted(int(k) for k in data["frames"].keys() if str(k).isdigit())
            return frames or [obj.frame]
        return [obj.frame]

    def get_frame_count(self, obj: AcceptanceRecord) -> int:
        return max(1, len(self.get_frames(obj)))


class AcceptanceRecordReadSerializer(serializers.ModelSerializer):
    reviewer = BasicUserSerializer(allow_null=True, required=False)
    snapshots = AcceptanceSnapshotReadSerializer(many=True, read_only=True)
    task_id = serializers.IntegerField(source="get_task_id", read_only=True)
    task_name = serializers.CharField(source="get_task_name", read_only=True)
    project_id = serializers.IntegerField(source="get_project_id", read_only=True, allow_null=True)
    frame_count = serializers.SerializerMethodField()
    frames = serializers.SerializerMethodField()

    class Meta:
        model = AcceptanceRecord
        fields = (
            "id",
            "job",
            "task_id",
            "task_name",
            "project_id",
            "frame",
            "frame_count",
            "frames",
            "reviewer",
            "action_type",
            "description",
            "status",
            "shape_count_before",
            "shape_count_after",
            "tag_count_before",
            "tag_count_after",
            "track_count_before",
            "track_count_after",
            "snapshots",
            "created_date",
            "updated_date",
        )
        read_only_fields = fields

    def _before_data(self, obj: AcceptanceRecord) -> dict:
        for snap in obj.snapshots.all():
            if snap.snapshot_type == SnapshotType.BEFORE:
                return snap.data if isinstance(snap.data, dict) else {}
        return {}

    def get_frames(self, obj: AcceptanceRecord) -> list[int]:
        data = self._before_data(obj)
        if data.get("version") == "session-v1" and isinstance(data.get("frames"), dict):
            frames = sorted(int(k) for k in data["frames"].keys() if str(k).isdigit())
            return frames or [obj.frame]
        return [obj.frame]

    def get_frame_count(self, obj: AcceptanceRecord) -> int:
        return max(1, len(self.get_frames(obj)))


class AcceptanceRecordWriteSerializer(serializers.ModelSerializer):
    snapshots = AcceptanceSnapshotWriteSerializer(many=True, required=False)

    class Meta:
        model = AcceptanceRecord
        fields = (
            "job",
            "frame",
            "action_type",
            "description",
            "status",
            "shape_count_before",
            "shape_count_after",
            "tag_count_before",
            "tag_count_after",
            "track_count_before",
            "track_count_after",
            "snapshots",
        )

    def to_representation(self, instance):
        serializer = AcceptanceRecordReadSerializer(instance, context=self.context)
        return serializer.data

    def validate(self, attrs):
        snapshots = attrs.get("snapshots")
        # On create, both BEFORE and AFTER snapshots are required:
        # AFTER is the current correct job result; BEFORE is stored only for comparison.
        if self.instance is None:
            if not snapshots:
                raise serializers.ValidationError(
                    {"snapshots": "Both 'before' and 'after' snapshots are required."}
                )
            types_seen = {s["snapshot_type"] for s in snapshots}
            missing = {SnapshotType.BEFORE, SnapshotType.AFTER} - types_seen
            if missing:
                raise serializers.ValidationError(
                    {"snapshots": f"Missing required snapshot type(s): {', '.join(sorted(missing))}"}
                )

        if snapshots:
            types_seen = set()
            for s in snapshots:
                stype = s["snapshot_type"]
                if stype in types_seen:
                    raise serializers.ValidationError(
                        {"snapshots": f"Duplicate snapshot type: {stype}"}
                    )
                types_seen.add(stype)
                if not isinstance(s.get("data"), dict):
                    raise serializers.ValidationError(
                        {"snapshots": f"Snapshot '{stype}' data must be a JSON object."}
                    )

        # Auto-fill counts from snapshots when omitted
        if snapshots:
            by_type = {s["snapshot_type"]: s["data"] for s in snapshots}
            before = by_type.get(SnapshotType.BEFORE) or {}
            after = by_type.get(SnapshotType.AFTER) or {}
            attrs.setdefault("shape_count_before", len(before.get("shapes") or []))
            attrs.setdefault("shape_count_after", len(after.get("shapes") or []))
            attrs.setdefault("tag_count_before", len(before.get("tags") or []))
            attrs.setdefault("tag_count_after", len(after.get("tags") or []))
            attrs.setdefault("track_count_before", len(before.get("tracks") or []))
            attrs.setdefault("track_count_after", len(after.get("tracks") or []))

        return attrs

    def create(self, validated_data):
        from django.db import transaction

        snapshots_data = validated_data.pop("snapshots", [])
        request = self.context.get("request")
        if request and hasattr(request, "user") and request.user and request.user.is_authenticated:
            validated_data["reviewer"] = request.user

        with transaction.atomic():
            record = AcceptanceRecord.objects.create(**validated_data)
            for snapshot_data in snapshots_data:
                AcceptanceAnnotationSnapshot.objects.create(
                    record=record, **snapshot_data
                )
        return record

    def update(self, instance, validated_data):
        from django.db import transaction

        snapshots_data = validated_data.pop("snapshots", None)

        with transaction.atomic():
            for attr, value in validated_data.items():
                setattr(instance, attr, value)
            instance.save()

            if snapshots_data is not None:
                instance.snapshots.all().delete()
                for snapshot_data in snapshots_data:
                    AcceptanceAnnotationSnapshot.objects.create(
                        record=instance, **snapshot_data
                    )

        return instance
