from __future__ import annotations

from collections.abc import Sequence
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from django.conf import settings

from cvat.apps.engine.models import Job
from cvat.apps.iam.permissions import OpenPolicyAgentPermission, get_iam_context
from cvat.utils import django_database as db_utils

from .models import AcceptanceAnnotationSnapshot, AcceptanceRecord
from .access import opa_settings_payload

if TYPE_CHECKING:
    from rest_framework.viewsets import ViewSet

    from cvat.apps.engine.types import ExtendedRequest
    from cvat.apps.iam.permissions import IamContext


def _user_has_acceptance_access(request: ExtendedRequest | None) -> bool:
    if not request or not getattr(request, "user", None):
        return False
    user = request.user
    if not getattr(user, "is_authenticated", False):
        return False
    profile = getattr(user, "profile", None)
    return bool(getattr(profile, "has_acceptance_access", False))


class AcceptanceRecordPermission(OpenPolicyAgentPermission):
    obj: AcceptanceRecord | None
    job: Job | None
    has_acceptance_access: bool

    class Scopes(StrEnum):
        LIST = "list"
        CREATE = "create"
        VIEW = "view"
        UPDATE = "update"
        DELETE = "delete"

    @classmethod
    def create(
        cls,
        request: ExtendedRequest,
        view: ViewSet,
        obj: AcceptanceRecord | None,
        iam_context: IamContext | None,
    ) -> list[OpenPolicyAgentPermission]:
        permissions = []
        Scopes = cls.Scopes

        for scope in cls.get_scopes(request, view, obj):
            if scope == Scopes.CREATE:
                job_id = request.data.get("job")
                if job_id is None:
                    # Let serializer validation surface a clean error
                    permissions.append(cls.create_base_perm(request, view, scope, iam_context, obj))
                    continue

                job = db_utils.get_or_404(Job, job_id)
                iam_context = get_iam_context(request, job)
                permissions.append(
                    cls.create_base_perm(
                        request, view, scope, iam_context, obj, job=job,
                    )
                )
            else:
                permissions.append(cls.create_base_perm(request, view, scope, iam_context, obj))

        return permissions

    @classmethod
    def create_base_perm(
        cls,
        request: ExtendedRequest,
        view,
        scope,
        iam_context: IamContext | None,
        obj: Any | None = None,
        **kwargs,
    ):
        if not iam_context and request:
            iam_context = get_iam_context(request, obj)
        return cls(
            scope=scope,
            obj=obj,
            has_acceptance_access=_user_has_acceptance_access(request),
            **(iam_context or {}),
            **kwargs,
        )

    @classmethod
    def create_scope_list(cls, request: ExtendedRequest, iam_context: IamContext | None = None):
        if not iam_context and request:
            iam_context = get_iam_context(request, None)
        return cls(
            **(iam_context or {}),
            scope="list",
            has_acceptance_access=_user_has_acceptance_access(request),
        )

    def __init__(self, **kwargs):
        if "job" in kwargs:
            self.job = kwargs.pop("job")
        else:
            self.job = None
        self.has_acceptance_access = bool(kwargs.pop("has_acceptance_access", False))
        super().__init__(**kwargs)
        self.url = settings.IAM_OPA_DATA_URL + "/acceptance_records/allow"

    def get_opa_auth_payload(self):
        data = super().get_opa_auth_payload()
        data["user"]["has_acceptance_access"] = self.has_acceptance_access
        return data

    def get_opa_settings_payload(self):
        return opa_settings_payload()

    @classmethod
    def _get_scopes(
        cls, request: ExtendedRequest, view: ViewSet, obj: AcceptanceRecord | None
    ) -> Sequence[str]:
        Scopes = cls.Scopes
        return [{
            "list": Scopes.LIST,
            "create": Scopes.CREATE,
            "retrieve": Scopes.VIEW,
            "partial_update": Scopes.UPDATE,
            "update": Scopes.UPDATE,
            "destroy": Scopes.DELETE,
        }.get(view.action, Scopes.VIEW)]

    def get_resource(self) -> dict[str, Any] | None:
        if self.obj is None and self.scope != self.Scopes.CREATE:
            return None

        job: Job | None = None
        obj_id: int | None = None
        reviewer_id: int | None = None

        if self.obj:
            obj_id = self.obj.id
            reviewer_id = self.obj.reviewer_id
            job = Job.objects.select_related("segment__task__project").get(pk=self.obj.job_id)
        elif self.scope == self.Scopes.CREATE and self.job:
            job = self.job
            if not isinstance(job, Job):
                job = db_utils.get_or_404(Job, job)
            job = Job.objects.select_related("segment__task__project").get(pk=job.id)

        if job is None:
            return {}

        task = job.segment.task
        project = task.project
        organization_id = task.organization_id

        return {
            "id": obj_id,
            "job": {
                "id": job.id,
                "assignee": {"id": job.assignee_id} if job.assignee_id else None,
            },
            "task": {
                "id": task.id,
                "owner": {"id": task.owner_id} if task.owner_id else None,
                "assignee": {"id": task.assignee_id} if task.assignee_id else None,
                "organization": {"id": organization_id} if organization_id else None,
            },
            "project": (
                {
                    "id": project.id,
                    "owner": {"id": project.owner_id} if project.owner_id else None,
                    "assignee": {"id": project.assignee_id} if project.assignee_id else None,
                }
                if project
                else None
            ),
            "reviewer": {"id": reviewer_id} if reviewer_id else None,
            "organization": {"id": organization_id} if organization_id else None,
        }


class AcceptanceSnapshotPermission(OpenPolicyAgentPermission):
    obj: AcceptanceAnnotationSnapshot | None
    has_acceptance_access: bool

    class Scopes(StrEnum):
        LIST = "list"
        VIEW = "view"

    @classmethod
    def create(
        cls,
        request: ExtendedRequest,
        view: ViewSet,
        obj: AcceptanceAnnotationSnapshot | None,
        iam_context: IamContext | None,
    ) -> list[OpenPolicyAgentPermission]:
        permissions = []
        for scope in cls.get_scopes(request, view, obj):
            permissions.append(cls.create_base_perm(request, view, scope, iam_context, obj))
        return permissions

    @classmethod
    def create_base_perm(
        cls,
        request: ExtendedRequest,
        view,
        scope,
        iam_context: IamContext | None,
        obj: Any | None = None,
        **kwargs,
    ):
        if not iam_context and request:
            iam_context = get_iam_context(request, obj)
        return cls(
            scope=scope,
            obj=obj,
            has_acceptance_access=_user_has_acceptance_access(request),
            **(iam_context or {}),
            **kwargs,
        )

    @classmethod
    def create_scope_list(cls, request: ExtendedRequest, iam_context: IamContext | None = None):
        if not iam_context and request:
            iam_context = get_iam_context(request, None)
        return cls(
            **(iam_context or {}),
            scope="list",
            has_acceptance_access=_user_has_acceptance_access(request),
        )

    def __init__(self, **kwargs):
        self.has_acceptance_access = bool(kwargs.pop("has_acceptance_access", False))
        super().__init__(**kwargs)
        self.url = settings.IAM_OPA_DATA_URL + "/acceptance_snapshots/allow"

    def get_opa_auth_payload(self):
        data = super().get_opa_auth_payload()
        data["user"]["has_acceptance_access"] = self.has_acceptance_access
        return data

    def get_opa_settings_payload(self):
        return opa_settings_payload()

    @classmethod
    def _get_scopes(
        cls,
        request: ExtendedRequest,
        view: ViewSet,
        obj: AcceptanceAnnotationSnapshot | None,
    ) -> Sequence[str]:
        Scopes = cls.Scopes
        return [{
            "list": Scopes.LIST,
            "retrieve": Scopes.VIEW,
        }.get(view.action, Scopes.VIEW)]

    def get_resource(self) -> dict[str, Any] | None:
        obj: AcceptanceAnnotationSnapshot | None = self.obj
        if obj is None:
            return None

        record = AcceptanceRecord.objects.select_related("job__segment__task__project").get(
            pk=obj.record_id
        )
        job = record.job
        task = job.segment.task
        project = task.project
        organization_id = record.organization_id

        return {
            "id": obj.id,
            "record_id": record.id,
            "job": {
                "id": job.id,
                "assignee": {"id": job.assignee_id} if job.assignee_id else None,
            },
            "task": {
                "id": task.id,
                "owner": {"id": task.owner_id} if task.owner_id else None,
                "assignee": {"id": task.assignee_id} if task.assignee_id else None,
                "organization": {"id": organization_id} if organization_id else None,
            },
            "project": (
                {
                    "id": project.id,
                    "owner": {"id": project.owner_id} if project.owner_id else None,
                    "assignee": {"id": project.assignee_id} if project.assignee_id else None,
                }
                if project
                else None
            ),
            "organization": {"id": organization_id} if organization_id else None,
        }
