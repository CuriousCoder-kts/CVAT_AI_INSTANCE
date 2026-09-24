from __future__ import annotations

from enum import StrEnum
from typing import TYPE_CHECKING

from django.contrib.auth.models import User
from django.db import models

from cvat.apps.engine.models import Job, TimestampedModel

if TYPE_CHECKING:
    from cvat.apps.organizations.models import Organization


class AcceptanceActionType(StrEnum):
    EDIT = "edit"
    DELETE = "delete"
    CREATE = "create"
    RESIZE = "resize"
    MOVE = "move"
    LABEL_CHANGE = "label_change"
    ATTRIBUTE_CHANGE = "attribute_change"
    OTHER = "other"

    @classmethod
    def choices(cls):
        return tuple((x.value, x.name) for x in cls)

    def __str__(self) -> str:
        return self.value


class SnapshotType(StrEnum):
    BEFORE = "before"
    AFTER = "after"

    @classmethod
    def choices(cls):
        return tuple((x.value, x.name) for x in cls)

    def __str__(self) -> str:
        return self.value


class AcceptanceRecordStatus(StrEnum):
    DRAFT = "draft"
    FINALIZED = "finalized"

    @classmethod
    def choices(cls):
        return tuple((x.value, x.name) for x in cls)

    def __str__(self) -> str:
        return self.value


class AcceptanceRecord(TimestampedModel):
    job = models.ForeignKey(
        Job,
        on_delete=models.CASCADE,
        related_name="acceptance_records",
        related_query_name="acceptance_record",
    )
    frame = models.PositiveIntegerField()
    reviewer = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="acceptance_records",
        related_query_name="acceptance_record",
    )
    action_type = models.CharField(
        max_length=32,
        choices=AcceptanceActionType.choices(),
        default=AcceptanceActionType.EDIT,
    )
    description = models.TextField(blank=True, default="")
    status = models.CharField(
        max_length=32,
        choices=AcceptanceRecordStatus.choices(),
        default=AcceptanceRecordStatus.FINALIZED,
    )
    shape_count_before = models.PositiveIntegerField(default=0)
    shape_count_after = models.PositiveIntegerField(default=0)
    tag_count_before = models.PositiveIntegerField(default=0)
    tag_count_after = models.PositiveIntegerField(default=0)
    track_count_before = models.PositiveIntegerField(default=0)
    track_count_after = models.PositiveIntegerField(default=0)

    snapshots: models.manager.RelatedManager[AcceptanceAnnotationSnapshot]

    class Meta:
        default_permissions = ()
        indexes = [
            models.Index(fields=["job", "frame"]),
            models.Index(fields=["reviewer"]),
            models.Index(fields=["created_date"]),
        ]

    def get_project_id(self) -> int | None:
        return self.job.get_project_id()

    def get_task_id(self) -> int:
        return self.job.get_task_id()

    def get_task_name(self) -> str:
        try:
            task = self.job.segment.task
            name = (getattr(task, "name", None) or "").strip()
            return name or f"Task #{task.id}"
        except Exception:
            return f"Task #{self.get_task_id()}"

    def get_job_id(self) -> int:
        return self.job_id

    @property
    def organization_id(self) -> int | None:
        return self.job.organization_id

    @property
    def organization(self) -> Organization | None:
        return self.job.organization

    def get_organization_slug(self) -> str:
        return self.job.get_organization_slug()


class AcceptanceAnnotationSnapshot(TimestampedModel):
    record = models.ForeignKey(
        AcceptanceRecord,
        on_delete=models.CASCADE,
        related_name="snapshots",
        related_query_name="snapshot",
    )
    snapshot_type = models.CharField(
        max_length=16,
        choices=SnapshotType.choices(),
    )
    data = models.JSONField()

    class Meta:
        default_permissions = ()
        constraints = [
            models.UniqueConstraint(
                fields=["record", "snapshot_type"],
                name="unique_snapshot_per_record_per_type",
            ),
        ]
