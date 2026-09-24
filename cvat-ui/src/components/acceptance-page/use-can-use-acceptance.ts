import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import Axios from 'axios';
import { CombinedState } from 'reducers';
import { shallowEqual } from 'utils/redux';
import {
    ACCEPTANCE_ACCESS_DEFAULT,
    AcceptanceAccessPolicy,
    isAcceptanceAdminUser,
    orgRoleAllowed,
} from './acceptance-access';

const ACCESS_POLICY_URL = '/api/acceptance/access-policy';

export interface UseCanUseAcceptanceOptions {
    /**
     * When server enables allow_task_staff, show Correct on jobs optimistically;
     * API still enforces. Nav / list stay false unless capability admin or org role.
     */
    includeTaskStaffGate?: boolean;
}

/**
 * Single gate for Corrections UI (nav, Correct button, /acceptance page).
 */
export function useCanUseAcceptance(options?: UseCanUseAcceptanceOptions): boolean {
    const { user, org } = useSelector((state: CombinedState) => ({
        user: state.auth.user,
        org: state.organizations.current,
    }), shallowEqual);

    const [policy, setPolicy] = useState<AcceptanceAccessPolicy>(ACCEPTANCE_ACCESS_DEFAULT);
    const [orgRole, setOrgRole] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const { data } = await Axios.get(ACCESS_POLICY_URL);
                if (!cancelled && data && typeof data === 'object') {
                    setPolicy({
                        org_roles: Array.isArray(data.org_roles) ? data.org_roles : [],
                        allow_task_staff: !!data.allow_task_staff,
                    });
                }
            } catch {
                if (!cancelled) setPolicy(ACCEPTANCE_ACCESS_DEFAULT);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!user || !org || typeof org.members !== 'function') {
                if (!cancelled) setOrgRole(null);
                return;
            }
            try {
                const memberships = await org.members(
                    { filter: `{"and":[{"==":[{"var":"user"},"${user.username}"]}]}` },
                );
                const role = memberships.length ? String(memberships[0].role || '') : null;
                if (!cancelled) setOrgRole(role);
            } catch {
                if (!cancelled) setOrgRole(null);
            }
        })();
        return () => { cancelled = true; };
    }, [user, org]);

    if (!user) return false;
    if (isAcceptanceAdminUser(user)) return true;
    if (orgRoleAllowed(orgRole, policy)) return true;
    if (options?.includeTaskStaffGate && policy.allow_task_staff) return true;
    return false;
}
