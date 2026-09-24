from __future__ import annotations

from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework import mixins, viewsets
from rest_framework.permissions import IsAuthenticated
from rest_framework.filters import OrderingFilter, SearchFilter
from django_filters.rest_framework import DjangoFilterBackend

from cvat.apps.iam.permissions import PolicyEnforcer
from cvat.apps.iam.filters import ORGANIZATION_OPEN_API_PARAMETERS, OrganizationFilterBackend

from .models import AcceptanceRecord, AcceptanceAnnotationSnapshot
from .permissions import AcceptanceRecordPermission, AcceptanceSnapshotPermission
from .serializers import (
    AcceptanceRecordListSerializer,
    AcceptanceRecordReadSerializer,
    AcceptanceRecordWriteSerializer,
    AcceptanceSnapshotReadSerializer,
)


@extend_schema(tags=["acceptance"])
@extend_schema_view(
    list=extend_schema(
        parameters=ORGANIZATION_OPEN_API_PARAMETERS,
    ),
    create=extend_schema(
        parameters=ORGANIZATION_OPEN_API_PARAMETERS,
    ),
    retrieve=extend_schema(
        parameters=ORGANIZATION_OPEN_API_PARAMETERS,
    ),
    update=extend_schema(
        parameters=ORGANIZATION_OPEN_API_PARAMETERS,
    ),
    partial_update=extend_schema(
        parameters=ORGANIZATION_OPEN_API_PARAMETERS,
    ),
    destroy=extend_schema(
        parameters=ORGANIZATION_OPEN_API_PARAMETERS,
    ),
)
class AcceptanceRecordViewSet(
    mixins.CreateModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    mixins.ListModelMixin,
    viewsets.GenericViewSet,
):
    queryset = AcceptanceRecord.objects.select_related("reviewer", "job").prefetch_related(
        "snapshots"
    ).order_by("-created_date")

    iam_permission_class = AcceptanceRecordPermission
    iam_supports_organization_params = True
    permission_classes = [IsAuthenticated, PolicyEnforcer]

    filter_backends = [
        DjangoFilterBackend,
        SearchFilter,
        OrderingFilter,
        OrganizationFilterBackend,
    ]
    filterset_fields = {
        "job": ["exact", "in"],
        "job__segment__task": ["exact", "in"],
        "job__segment__task__project": ["exact", "in"],
        "frame": ["exact", "gte", "lte"],
        "reviewer": ["exact", "in"],
        "action_type": ["exact", "in"],
        "status": ["exact", "in"],
    }
    search_fields = ["description"]
    ordering_fields = ["created_date", "updated_date", "frame", "id", "action_type"]
    ordering = ["-created_date"]

    def get_serializer_class(self):
        if self.action == "list":
            return AcceptanceRecordListSerializer
        if self.action == "retrieve":
            return AcceptanceRecordReadSerializer
        return AcceptanceRecordWriteSerializer

    def get_queryset(self):
        queryset = super().get_queryset()
        if self.action == "list":
            # Applies OPA /filter (incl. org_filter_proof) required by OrganizationFilterBackend
            perm = AcceptanceRecordPermission.create_scope_list(self.request)
            queryset = perm.filter(queryset)
        return queryset


@extend_schema(tags=["acceptance"])
class AcceptanceSnapshotViewSet(
    mixins.RetrieveModelMixin,
    mixins.ListModelMixin,
    viewsets.GenericViewSet,
):
    queryset = AcceptanceAnnotationSnapshot.objects.select_related("record").order_by("id")

    iam_permission_class = AcceptanceSnapshotPermission
    iam_supports_organization_params = True
    permission_classes = [IsAuthenticated, PolicyEnforcer]

    filter_backends = [
        DjangoFilterBackend,
        OrderingFilter,
        OrganizationFilterBackend,
    ]
    filterset_fields = {
        "record": ["exact", "in"],
        "snapshot_type": ["exact", "in"],
        "record__job": ["exact", "in"],
    }
    ordering_fields = ["created_date"]
    ordering = ["-created_date"]

    serializer_class = AcceptanceSnapshotReadSerializer

    def get_queryset(self):
        queryset = super().get_queryset()
        if self.action == "list":
            perm = AcceptanceSnapshotPermission.create_scope_list(self.request)
            queryset = perm.filter(queryset)
        return queryset
