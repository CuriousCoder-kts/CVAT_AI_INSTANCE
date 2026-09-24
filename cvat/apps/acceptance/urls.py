from __future__ import annotations

from django.urls import include, path
from rest_framework.routers import DefaultRouter
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .access import public_access_policy
from .views import AcceptanceRecordViewSet, AcceptanceSnapshotViewSet


class AcceptanceAccessPolicyView(APIView):
    """UI reads this to mirror OPA policy without hard-coding roles.

    Any authenticated user may read the policy; enforcement stays in OPA.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(public_access_policy())


router = DefaultRouter(trailing_slash=False)
router.register(r"records", AcceptanceRecordViewSet, basename="acceptance_records")
router.register(r"snapshots", AcceptanceSnapshotViewSet, basename="acceptance_snapshots")

urlpatterns = [
    path("access-policy", AcceptanceAccessPolicyView.as_view(), name="acceptance_access_policy"),
    path("", include(router.urls)),
]
