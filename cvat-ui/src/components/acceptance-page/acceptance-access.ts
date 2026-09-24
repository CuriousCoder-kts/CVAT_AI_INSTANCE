/**
 * Corrections access helpers.
 *
 * Primary gate: IAM admin AND Profile.has_acceptance_access (user.hasAcceptanceAccess).
 * Optional: org roles / task staff from GET /api/acceptance/access-policy.
 */

import { MembershipRole } from 'cvat-core-wrapper';

export type AcceptanceOrgRole = `${MembershipRole}`;

export interface AcceptanceAccessPolicy {
    org_roles: AcceptanceOrgRole[];
    allow_task_staff: boolean;
}

/** Fallback while policy loads (capability flag is on the user object). */
export const ACCEPTANCE_ACCESS_DEFAULT: AcceptanceAccessPolicy = {
    org_roles: [],
    allow_task_staff: false,
};

export function isIamAdmin(user: {
    groups?: string[];
    isSuperuser?: boolean;
} | null | undefined): boolean {
    if (!user) return false;
    if (user.isSuperuser) return true;
    return (user.groups || []).includes('admin');
}

/** IAM admin with Corrections Profile capability. */
export function isAcceptanceAdminUser(
    user: {
        groups?: string[];
        isSuperuser?: boolean;
        hasAcceptanceAccess?: boolean;
    } | null | undefined,
): boolean {
    if (!isIamAdmin(user)) return false;
    return !!user?.hasAcceptanceAccess;
}

export function orgRoleAllowed(
    role: string | null | undefined,
    policy: AcceptanceAccessPolicy,
): boolean {
    if (!role || !policy.org_roles.length) return false;
    return policy.org_roles.includes(role as AcceptanceOrgRole);
}
