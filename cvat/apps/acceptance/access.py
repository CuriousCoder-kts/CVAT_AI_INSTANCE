"""Corrections / Acceptance access policy (org-role / task-staff knobs).

Primary gate is ``Profile.has_acceptance_access`` (AND IAM admin in OPA),
managed in Django Admin — not an env username allowlist.

Optional later::

    export CVAT_ACCEPTANCE_ORG_ROLES=owner
    export CVAT_ACCEPTANCE_ALLOW_TASK_STAFF=true

Restart ``cvat_server`` / ``cvat_opa`` after env changes.
"""

from __future__ import annotations

from django.conf import settings


def acceptance_org_roles() -> tuple[str, ...]:
    return tuple(getattr(settings, "ACCEPTANCE_ORG_ROLES", ()) or ())


def acceptance_allow_task_staff() -> bool:
    return bool(getattr(settings, "ACCEPTANCE_ALLOW_TASK_STAFF", False))


def opa_settings_payload() -> dict:
    """Injected into OPA ``input.settings`` for acceptance_* packages only."""
    return {
        "acceptance_org_roles": list(acceptance_org_roles()),
        "acceptance_allow_task_staff": acceptance_allow_task_staff(),
    }


def public_access_policy() -> dict:
    """JSON for the UI (authenticated). Keep in sync with OPA settings keys."""
    return {
        "org_roles": list(acceptance_org_roles()),
        "allow_task_staff": acceptance_allow_task_staff(),
    }
