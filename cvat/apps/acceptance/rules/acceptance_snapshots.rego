package acceptance_snapshots

import rego.v1

import data.utils
import data.organizations

# Same capability gate as acceptance_records.

default allow := false

org_roles := object.get(input.settings, "acceptance_org_roles", [])
allow_task_staff := object.get(input.settings, "acceptance_allow_task_staff", false)

is_project_owner if {
    input.resource.project.owner.id == input.auth.user.id
}

is_project_assignee if {
    input.resource.project.assignee.id == input.auth.user.id
}

is_task_owner if {
    input.resource.task.owner.id == input.auth.user.id
}

is_task_assignee if {
    input.resource.task.assignee.id == input.auth.user.id
}

is_project_staff if is_project_owner
is_project_staff if is_project_assignee

is_task_staff if is_project_staff
is_task_staff if is_task_owner
is_task_staff if is_task_assignee

has_configured_org_role if {
    count(org_roles) > 0
    utils.is_organization
    input.auth.organization.user.role in org_roles
}

same_resource_org if {
    utils.is_organization
    input.resource.organization.id == input.auth.organization.id
}

is_acceptance_admin if {
    utils.is_admin
    object.get(input.auth.user, "has_acceptance_access", false)
}

allow if {
    is_acceptance_admin
}

allow if {
    input.scope == utils.LIST
    has_configured_org_role
    utils.has_perm(utils.USER)
}

allow if {
    input.scope == utils.VIEW
    has_configured_org_role
    same_resource_org
    utils.has_perm(utils.USER)
}

allow if {
    allow_task_staff
    input.scope == utils.VIEW
    is_task_staff
    utils.has_perm(utils.USER)
}

q_user_is_staff(user) := ["|",
    {"record__job__segment__task__owner_id": user.id},
    {"record__job__segment__task__assignee_id": user.id},
    {"record__job__segment__task__project__owner_id": user.id},
    {"record__job__segment__task__project__assignee_id": user.id},
    {"record__reviewer_id": user.id},
]

deny_all := {"id__in": []}

base_filter := {} if {
    is_acceptance_admin
} else := {} if {
    has_configured_org_role
    utils.has_perm(utils.USER)
} else := qobject if {
    allow_task_staff
    utils.has_perm(utils.USER)
    user := input.auth.user
    qobject := q_user_is_staff(user)
} else := deny_all

filter := utils.add_organization_filter(base_filter, [
    "record__job__segment__task__organization",
])
