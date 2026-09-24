// Copyright (C) 2021-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import {
    OrganizationMembersFilter,
    SerializedBailianSettings, SerializedInvitationData, SerializedOrganization, SerializedOrganizationContact, SerializedUser,
    SerializedAIFunctionInstance, SerializedAIFunctionInstanceWrite, AIFeatureKind, AIProviderKind,
} from './server-response-types';
import {
    checkFilter, checkObjectType, fieldsToSnakeCase, isEnum, isInteger, isString,
} from './common';
import config from './config';
import { MembershipRole } from './enums';
import { ArgumentError, DataError } from './exceptions';
import PluginRegistry from './plugins';
import serverProxy from './server-proxy';
import User from './user';

interface SerializedMembershipData {
    id: number;
    user: SerializedUser;
    is_active: boolean;
    joined_date: string;
    role: MembershipRole;
    invitation: SerializedInvitationData | null;
}

function validateName(name: unknown): void {
    checkObjectType('organization name', name, 'string');
}

function validateDescription(description: unknown): void {
    checkObjectType('organization description', description, 'string');
}

function validateContact(contact: unknown): void {
    checkObjectType('contact', contact, null, { cls: Object, name: 'Object' });
    for (const prop of Object.keys(contact)) {
        checkObjectType('organization contact', contact[prop], 'string');
    }
}

export default class Organization {
    public readonly id: number;
    public readonly slug: string;
    public readonly createdDate: string;
    public readonly updatedDate: string;
    public readonly owner: User;
    public readonly contact: SerializedOrganizationContact;
    public readonly name: string;
    public readonly description: string;

    constructor(initialData: SerializedOrganization) {
        const data: SerializedOrganization = {
            id: undefined,
            slug: undefined,
            name: undefined,
            description: undefined,
            created_date: undefined,
            updated_date: undefined,
            owner: undefined,
            contact: undefined,
        };

        for (const prop of Object.keys(data)) {
            if (prop in initialData) {
                data[prop] = initialData[prop];
            }
        }

        if (data.owner) data.owner = new User(data.owner);

        checkObjectType('slug', data.slug, 'string');
        if (typeof data.name !== 'undefined') {
            validateName(data.name);
        }

        if (typeof data.description !== 'undefined') {
            validateDescription(data.description);
        }

        if (typeof data.id !== 'undefined') {
            checkObjectType('id', data.id, 'number');
        }

        if (typeof data.contact !== 'undefined') {
            validateContact(data.contact);
        }

        if (typeof data.owner !== 'undefined' && data.owner !== null) {
            checkObjectType('owner', data.owner, null, { cls: User, name: 'User' });
        }

        Object.defineProperties(this, {
            id: {
                get: () => data.id,
            },
            slug: {
                get: () => data.slug,
            },
            name: {
                get: () => data.name,
            },
            description: {
                get: () => data.description,
            },
            contact: {
                get: () => ({ ...data.contact ?? {} }),
            },
            owner: {
                get: () => data.owner,
            },
            createdDate: {
                get: () => data.created_date,
            },
            updatedDate: {
                get: () => data.updated_date,
            },
        });
    }

    // Method updates organization data if it was created before, or creates a new organization
    public async save(
        fields: Partial<Pick<SerializedOrganization, 'name' | 'description' | 'contact'>> = {},
    ): Promise<Organization> {
        const result = await PluginRegistry.apiWrapper.call(this, Organization.prototype.save, fields);
        return result;
    }

    // Method returns paginatable list of organization members
    public async members(filter: OrganizationMembersFilter = { page: 1, pageSize: 10 }): Promise<Membership[]> {
        const result = await PluginRegistry.apiWrapper.call(
            this,
            Organization.prototype.members,
            {
                ...filter,
                org: this.slug,
            },
        );
        return result;
    }

    // Method removes the organization
    public async remove(): Promise<void> {
        const result = await PluginRegistry.apiWrapper.call(this, Organization.prototype.remove);
        return result;
    }

    // Method invites new members by email
    public async invite(email: string, role: MembershipRole): Promise<void> {
        const result = await PluginRegistry.apiWrapper.call(this, Organization.prototype.invite, email, role);
        return result;
    }

    // Directly create active member accounts with passwords (no email invitation flow)
    public async createMembers(members: Array<{
        username: string;
        email: string;
        first_name?: string;
        last_name?: string;
        password?: string;
        role: MembershipRole;
    }>): Promise<{
        created_count: number;
        error_count: number;
        results: Array<{
            username: string;
            email: string;
            first_name: string;
            last_name: string;
            role: MembershipRole;
            password: string;
            user_id: number;
            membership_id: number;
        }>;
        errors: Array<{ index: number; username?: string; error: string }>;
    }> {
        const result = await PluginRegistry.apiWrapper.call(
            this,
            Organization.prototype.createMembers,
            members,
        );
        return result;
    }

    // Method allows a user to get out from an organization
    // The difference between deleteMembership is that membershipId is unknown in this case
    public async leave(user: User): Promise<void> {
        const result = await PluginRegistry.apiWrapper.call(this, Organization.prototype.leave, user);
        return result;
    }

    // Method allows to change a membership role
    public async updateMembership(membershipId: number, role: MembershipRole): Promise<void> {
        const result = await PluginRegistry.apiWrapper.call(
            this,
            Organization.prototype.updateMembership,
            membershipId,
            role,
        );
        return result;
    }

    // Method allows to kick a user from an organization
    public async deleteMembership(membershipId: number): Promise<void> {
        const result = await PluginRegistry.apiWrapper.call(
            this,
            Organization.prototype.deleteMembership,
            membershipId,
        );
        return result;
    }

    public async resendInvitation(key: string): Promise<void> {
        const result = await PluginRegistry.apiWrapper.call(
            this,
            Organization.prototype.resendInvitation,
            key,
        );
        return result;
    }

    public async bailianSettings(): Promise<BailianSettings> {
        const result = await PluginRegistry.apiWrapper.call(
            this,
            Organization.prototype.bailianSettings,
        );
        return result;
    }

    public async updateBailianSettings(
        fields: { apiKey?: string | null; apiUrl?: string; model?: string },
    ): Promise<BailianSettings> {
        const result = await PluginRegistry.apiWrapper.call(
            this,
            Organization.prototype.updateBailianSettings,
            fields,
        );
        return result;
    }

    public async listAIFunctionInstances(
        filters?: { featureKind?: AIFeatureKind; provider?: AIProviderKind; isEnabled?: boolean },
    ): Promise<AIFunctionInstance[]> {
        const result = await PluginRegistry.apiWrapper.call(
            this,
            Organization.prototype.listAIFunctionInstances,
            filters || {},
        );
        return result;
    }

    public async getAIFunctionInstance(slug: string): Promise<AIFunctionInstance> {
        const result = await PluginRegistry.apiWrapper.call(
            this,
            Organization.prototype.getAIFunctionInstance,
            slug,
        );
        return result;
    }

    public async createAIFunctionInstance(
        data: Parameters<typeof Organization.prototype.createAIFunctionInstance>[0],
    ): Promise<AIFunctionInstance> {
        const result = await PluginRegistry.apiWrapper.call(
            this,
            Organization.prototype.createAIFunctionInstance,
            data,
        );
        return result;
    }

    public async updateAIFunctionInstance(
        slug: string,
        data: Parameters<typeof Organization.prototype.updateAIFunctionInstance>[1],
    ): Promise<AIFunctionInstance> {
        const result = await PluginRegistry.apiWrapper.call(
            this,
            Organization.prototype.updateAIFunctionInstance,
            slug,
            data,
        );
        return result;
    }

    public async deleteAIFunctionInstance(slug: string): Promise<void> {
        const result = await PluginRegistry.apiWrapper.call(
            this,
            Organization.prototype.deleteAIFunctionInstance,
            slug,
        );
        return result;
    }

    public async enableAIFunctionInstance(slug: string): Promise<AIFunctionInstance> {
        const result = await PluginRegistry.apiWrapper.call(
            this,
            Organization.prototype.enableAIFunctionInstance,
            slug,
        );
        return result;
    }

    public async disableAIFunctionInstance(slug: string): Promise<AIFunctionInstance> {
        const result = await PluginRegistry.apiWrapper.call(
            this,
            Organization.prototype.disableAIFunctionInstance,
            slug,
        );
        return result;
    }

    public async setDefaultAIFunctionInstance(slug: string): Promise<AIFunctionInstance> {
        const result = await PluginRegistry.apiWrapper.call(
            this,
            Organization.prototype.setDefaultAIFunctionInstance,
            slug,
        );
        return result;
    }

    public async probeHttpMicroservice(fields: {
        apiUrl: string;
        httpTimeoutSeconds?: number;
        apiKey?: string;
        instanceSlug?: string;
    }): Promise<{
        ok: boolean;
        api_url?: string;
        health_url?: string;
        labels_url?: string;
        message?: string;
        health?: {
            attempted?: boolean;
            ok?: boolean;
            reachable?: boolean;
            status_code?: number | null;
            url?: string;
            detail?: string;
        };
        labels?: {
            attempted?: boolean;
            ok?: boolean;
            reachable?: boolean;
            status_code?: number | null;
            url?: string;
            detail?: string;
            items?: Array<{ name: string; type?: string; description?: string }>;
        };
    }> {
        const result = await PluginRegistry.apiWrapper.call(
            this,
            Organization.prototype.probeHttpMicroservice,
            fields,
        );
        return result;
    }
}

export class BailianSettings {
    #apiUrl: string;
    #model: string;
    #hasApiKey: boolean;
    #updatedDate: string;
    #updatedBy: User | null;

    constructor(initialData: SerializedBailianSettings) {
        this.#apiUrl = initialData.api_url;
        this.#model = initialData.model;
        this.#hasApiKey = initialData.has_api_key;
        this.#updatedDate = initialData.updated_date;
        this.#updatedBy = initialData.updated_by ? new User(initialData.updated_by) : null;
    }

    get apiUrl(): string {
        return this.#apiUrl;
    }

    get model(): string {
        return this.#model;
    }

    get hasApiKey(): boolean {
        return this.#hasApiKey;
    }

    get updatedDate(): string {
        return this.#updatedDate;
    }

    get updatedBy(): User | null {
        return this.#updatedBy;
    }
}

export class AIFunctionInstance {
    #id: number;
    #slug: string;
    #name: string;
    #featureKind: AIFeatureKind;
    #provider: AIProviderKind;
    #isEnabled: boolean;
    #isDefault: boolean;
    #config: Record<string, any>;
    #hasSensitiveConfig: Record<string, boolean>;
    #nuclioFunctionId: string;
    #createdDate: string;
    #updatedDate: string;
    #updatedBy: User | null;
    #lastUsedAt: string | null;

    constructor(initialData: SerializedAIFunctionInstance) {
        this.#id = initialData.id;
        this.#slug = initialData.slug;
        this.#name = initialData.name;
        this.#featureKind = initialData.feature_kind;
        this.#provider = initialData.provider;
        this.#isEnabled = initialData.is_enabled;
        this.#isDefault = initialData.is_default;
        this.#config = initialData.config || {};
        this.#hasSensitiveConfig = initialData.has_sensitive_config || {};
        this.#nuclioFunctionId = initialData.nuclio_function_id || '';
        this.#createdDate = initialData.created_date;
        this.#updatedDate = initialData.updated_date;
        this.#updatedBy = initialData.updated_by ? new User(initialData.updated_by) : null;
        this.#lastUsedAt = initialData.last_used_at || null;
    }

    get id(): number {
        return this.#id;
    }

    get slug(): string {
        return this.#slug;
    }

    get name(): string {
        return this.#name;
    }

    get featureKind(): AIFeatureKind {
        return this.#featureKind;
    }

    get provider(): AIProviderKind {
        return this.#provider;
    }

    get isEnabled(): boolean {
        return this.#isEnabled;
    }

    get isDefault(): boolean {
        return this.#isDefault;
    }

    get config(): Record<string, any> {
        return { ...this.#config };
    }

    get hasSensitiveConfig(): Record<string, boolean> {
        return { ...this.#hasSensitiveConfig };
    }

    get nuclioFunctionId(): string {
        return this.#nuclioFunctionId;
    }

    get createdDate(): string {
        return this.#createdDate;
    }

    get updatedDate(): string {
        return this.#updatedDate;
    }

    get updatedBy(): User | null {
        return this.#updatedBy;
    }

    get lastUsedAt(): string | null {
        return this.#lastUsedAt;
    }

    public toJSON(): SerializedAIFunctionInstance {
        return {
            id: this.#id,
            slug: this.#slug,
            name: this.#name,
            feature_kind: this.#featureKind,
            provider: this.#provider,
            is_enabled: this.#isEnabled,
            is_default: this.#isDefault,
            config: { ...this.#config },
            has_sensitive_config: { ...this.#hasSensitiveConfig },
            nuclio_function_id: this.#nuclioFunctionId,
            created_date: this.#createdDate,
            updated_date: this.#updatedDate,
            updated_by: (this.#updatedBy && ('id' in this.#updatedBy) ? {
                id: (this.#updatedBy as any).id || null,
                username: (this.#updatedBy as any).username || null,
                first_name: (this.#updatedBy as any).firstName || null,
                last_name: (this.#updatedBy as any).lastName || null,
                url: '',
                email: '',
                email_verification_required: false,
                has_analytics_access: false,
                has_acceptance_access: false,
            } as SerializedUser : null) as SerializedUser | null,
            last_used_at: this.#lastUsedAt,
        };
    }
}

export class Invitation {
    #createdDate: string;
    #owner: User | null;
    #key: string;
    #expired: boolean;
    #organization: number;
    #organizationInfo: Organization;

    constructor(initialData: SerializedInvitationData) {
        this.#createdDate = initialData.created_date;
        this.#owner = initialData.owner ? new User(initialData.owner) : null;
        this.#key = initialData.key;
        this.#expired = initialData.expired;
        this.#organization = initialData.organization;
        this.#organizationInfo = new Organization(initialData.organization_info);
    }

    get owner(): User | null {
        return this.#owner;
    }

    get createdDate(): string {
        return this.#createdDate;
    }

    get key(): string {
        return this.#key;
    }

    get expired(): boolean {
        return this.#expired;
    }

    get organization(): number | Organization {
        return this.#organization;
    }

    get organizationInfo(): Organization {
        return this.#organizationInfo;
    }
}

export class Membership {
    #id: number;
    #user: User;
    #isActive: boolean;
    #joinedDate: string;
    #role: MembershipRole;
    #invitation: Invitation | null;

    constructor(initialData: SerializedMembershipData) {
        this.#id = initialData.id;
        this.#user = new User(initialData.user);
        this.#isActive = initialData.is_active;
        this.#joinedDate = initialData.joined_date;
        this.#role = initialData.role;
        this.#invitation = initialData.invitation ? new Invitation(initialData.invitation) : null;
    }

    get id(): number {
        return this.#id;
    }

    get user(): User {
        return this.#user;
    }

    get isActive(): boolean {
        return this.#isActive;
    }
    get joinedDate(): string {
        return this.#joinedDate;
    }
    get role(): MembershipRole {
        return this.#role;
    }
    get invitation(): Invitation {
        return this.#invitation;
    }
}

Object.defineProperties(Organization.prototype.save, {
    implementation: {
        writable: false,
        enumerable: false,
        value: async function implementation(
            fields: Parameters<typeof Organization.prototype.save>[0],
        ) {
            if (typeof this.id === 'number') {
                const organizationData = {
                    ...('name' in fields ? { name: fields.name } : {}),
                    ...('description' in fields ? { description: fields.description } : {}),
                    ...('contact' in fields ? { contact: fields.contact } : {}),
                };

                if (Object.hasOwn(organizationData, 'name') && typeof organizationData.name !== 'string') {
                    validateName(organizationData.name);
                }

                if (
                    Object.hasOwn(organizationData, 'description') &&
                    typeof organizationData.description !== 'string'
                ) {
                    validateDescription(organizationData.description);
                }

                if (Object.hasOwn(organizationData, 'contact')) {
                    validateContact(organizationData.contact);
                }

                const result = await serverProxy.organizations.update(this.id, organizationData);
                return new Organization(result);
            }

            const organizationData = {
                slug: this.slug,
                name: this.name || this.slug,
                description: this.description,
                contact: this.contact,
            };

            const result = await serverProxy.organizations.create(organizationData);
            return new Organization(result);
        },
    },
});

Object.defineProperties(Organization.prototype.members, {
    implementation: {
        writable: false,
        enumerable: false,
        value: async function implementation(
            filter: Parameters<typeof Organization.prototype.members>[0],
        ) {
            checkFilter(filter, {
                org: isString,
                page: isInteger,
                pageSize: isInteger,
                search: isString,
                filter: isString,
                sort: isString,
            });

            const params = fieldsToSnakeCase(filter);
            const result = await serverProxy.organizations.members(params);

            const memberships = await Promise.all(result.results.map(async (rawMembership) => {
                const { invitation } = rawMembership;
                let rawInvitation = null;
                if (invitation) {
                    try {
                        const invitationData = await serverProxy.organizations.invitations({ key: invitation });
                        [rawInvitation] = invitationData.results;
                    // eslint-disable-next-line no-empty
                    } catch (_e) {}
                }

                return new Membership({
                    ...rawMembership,
                    invitation: rawInvitation,
                });
            }));

            return Object.assign(memberships, { count: result.count });
        },
    },
});

Object.defineProperties(Organization.prototype.remove, {
    implementation: {
        writable: false,
        enumerable: false,
        value: async function implementation() {
            if (typeof this.id === 'number') {
                await serverProxy.organizations.delete(this.id);
                config.organization = {
                    organizationID: null,
                    organizationSlug: null,
                };
            }
        },
    },
});

Object.defineProperties(Organization.prototype.invite, {
    implementation: {
        writable: false,
        enumerable: false,
        value: async function implementation(email: string, role: MembershipRole) {
            checkObjectType('email', email, 'string');
            if (!isEnum.bind(MembershipRole)(role)) {
                throw new ArgumentError(`Role must be one of: ${Object.values(MembershipRole).toString()}`);
            }

            if (typeof this.id === 'number') {
                await serverProxy.organizations.invite(this.id, { email, role });
            }
        },
    },
});

Object.defineProperties(Organization.prototype.createMembers, {
    implementation: {
        writable: false,
        enumerable: false,
        value: async function implementation(
            members: Parameters<typeof Organization.prototype.createMembers>[0],
        ) {
            checkObjectType('members', members, null, { cls: Array, name: 'Array' });
            if (typeof this.id !== 'number') {
                throw new DataError('Organization is not created');
            }
            const payload = members.map((m) => ({
                username: m.username,
                email: m.email,
                first_name: m.first_name ?? '',
                last_name: m.last_name ?? '',
                password: m.password ?? '',
                role: m.role,
            }));
            const result = await serverProxy.organizations.createMembers(this.id, { members: payload });
            return result;
        },
    },
});

Object.defineProperties(Organization.prototype.updateMembership, {
    implementation: {
        writable: false,
        enumerable: false,
        value: async function implementation(membershipId: number, role: MembershipRole) {
            checkObjectType('membershipId', membershipId, 'number');
            if (!isEnum.bind(MembershipRole)(role)) {
                throw new ArgumentError(`Role must be one of: ${Object.values(MembershipRole).toString()}`);
            }

            if (typeof this.id === 'number') {
                await serverProxy.organizations.updateMembership(membershipId, { role });
            }
        },
    },
});

Object.defineProperties(Organization.prototype.deleteMembership, {
    implementation: {
        writable: false,
        enumerable: false,
        value: async function implementation(membershipId: number) {
            checkObjectType('membershipId', membershipId, 'number');
            if (typeof this.id === 'number') {
                await serverProxy.organizations.deleteMembership(membershipId);
            }
        },
    },
});

Object.defineProperties(Organization.prototype.leave, {
    implementation: {
        writable: false,
        enumerable: false,
        value: async function implementation(user: User) {
            checkObjectType('user', user, null, { cls: User, name: 'User' });
            if (typeof this.id === 'number') {
                const result = await serverProxy.organizations.members({
                    page: 1,
                    pageSize: 10,
                    org: this.slug,
                    filter: JSON.stringify({
                        and: [{
                            '==': [{ var: 'user' }, user.username],
                        }],
                    }),
                });
                const [membership] = result.results;
                if (!membership) {
                    throw new DataError(
                        `Could not find membership for user ${user.username} in organization ${this.slug}`,
                    );
                }
                await serverProxy.organizations.deleteMembership(membership.id);
            }
        },
    },
});

Object.defineProperties(Organization.prototype.resendInvitation, {
    implementation: {
        writable: false,
        enumerable: false,
        value: async function implementation(key: string) {
            checkObjectType('key', key, 'string');
            if (typeof this.id === 'number') {
                await serverProxy.organizations.resendInvitation(key);
            }
        },
    },
});

Object.defineProperties(Organization.prototype.bailianSettings, {
    implementation: {
        writable: false,
        enumerable: false,
        value: async function implementation() {
            if (typeof this.id === 'number') {
                const result = await serverProxy.organizations.bailianSettings.get(this.id);
                return new BailianSettings(result);
            }
            throw new DataError('Organization is not created');
        },
    },
});

Object.defineProperties(Organization.prototype.updateBailianSettings, {
    implementation: {
        writable: false,
        enumerable: false,
        value: async function implementation(
            fields: Parameters<typeof Organization.prototype.updateBailianSettings>[0],
        ) {
            checkObjectType('fields', fields, null, { cls: Object, name: 'Object' });
            if (typeof this.id === 'number') {
                const payload: { api_url?: string; model?: string; api_key?: string | null } = {};
                if (Object.hasOwn(fields, 'apiUrl')) payload.api_url = fields.apiUrl || '';
                if (Object.hasOwn(fields, 'model')) payload.model = fields.model || '';
                if (Object.hasOwn(fields, 'apiKey') && fields.apiKey !== undefined) payload.api_key = fields.apiKey;
                const result = await serverProxy.organizations.bailianSettings.update(this.id, payload);
                return new BailianSettings(result);
            }
            throw new DataError('Organization is not created');
        },
    },
});

function _aiFiltersToSnakeCase(filters: any): any {
    return fieldsToSnakeCase(filters);
}

Object.defineProperties(Organization.prototype.listAIFunctionInstances, {
    implementation: {
        writable: false,
        enumerable: false,
        value: async function implementation(
            filters: Parameters<typeof Organization.prototype.listAIFunctionInstances>[0],
        ) {
            checkObjectType('filters', filters, null, { cls: Object, name: 'Object' });
            if (typeof this.id === 'number') {
                const params = _aiFiltersToSnakeCase(filters);
                const result = await serverProxy.organizations.aiFunctionInstances.list(this.id, params);
                return result.map((raw: SerializedAIFunctionInstance) => new AIFunctionInstance(raw));
            }
            throw new DataError('Organization is not created');
        },
    },
});

Object.defineProperties(Organization.prototype.getAIFunctionInstance, {
    implementation: {
        writable: false,
        enumerable: false,
        value: async function implementation(
            slug: string,
        ) {
            checkObjectType('slug', slug, 'string');
            if (typeof this.id === 'number') {
                const result = await serverProxy.organizations.aiFunctionInstances.get(this.id, slug);
                return new AIFunctionInstance(result);
            }
            throw new DataError('Organization is not created');
        },
    },
});

function _aiWritePayloadFromCamel(
    data: Parameters<typeof Organization.prototype.createAIFunctionInstance>[0],
): SerializedAIFunctionInstanceWrite {
    const assign = <K extends keyof SerializedAIFunctionInstanceWrite>(
        key: K,
        present: boolean,
        value: SerializedAIFunctionInstanceWrite[K] | undefined,
    ): Partial<SerializedAIFunctionInstanceWrite> => (
        present && value !== undefined ? { [key]: value } as Partial<SerializedAIFunctionInstanceWrite> : {}
    );
    const payload: SerializedAIFunctionInstanceWrite = {
        ...assign('slug', 'slug' in data, data.slug),
        ...assign('name', 'name' in data, data.name),
        ...assign('feature_kind', 'featureKind' in data, data.featureKind),
        ...assign('provider', 'provider' in data, data.provider),
        ...assign('is_enabled', 'isEnabled' in data, data.isEnabled),
        ...assign('is_default', 'isDefault' in data, data.isDefault),
        ...assign('nuclio_function_id', 'nuclioFunctionId' in data, data.nuclioFunctionId),
        ...('config' in data && data.config ? { config: data.config } : {}),
    };
    return payload;
}

Object.defineProperties(Organization.prototype.createAIFunctionInstance, {
    implementation: {
        writable: false,
        enumerable: false,
        value: async function implementation(
            data: Parameters<typeof Organization.prototype.createAIFunctionInstance>[0],
        ) {
            checkObjectType('data', data, null, { cls: Object, name: 'Object' });
            if (typeof this.id === 'number') {
                const payload = _aiWritePayloadFromCamel(data);
                const result = await serverProxy.organizations.aiFunctionInstances.create(this.id, payload);
                return new AIFunctionInstance(result);
            }
            throw new DataError('Organization is not created');
        },
    },
});

Object.defineProperties(Organization.prototype.updateAIFunctionInstance, {
    implementation: {
        writable: false,
        enumerable: false,
        value: async function implementation(
            slug: string,
            data: Parameters<typeof Organization.prototype.updateAIFunctionInstance>[1],
        ) {
            checkObjectType('slug', slug, 'string');
            checkObjectType('data', data, null, { cls: Object, name: 'Object' });
            if (typeof this.id === 'number') {
                const payload = _aiWritePayloadFromCamel(data as any);
                const result = await serverProxy.organizations.aiFunctionInstances.update(this.id, slug, payload);
                return new AIFunctionInstance(result);
            }
            throw new DataError('Organization is not created');
        },
    },
});

Object.defineProperties(Organization.prototype.deleteAIFunctionInstance, {
    implementation: {
        writable: false,
        enumerable: false,
        value: async function implementation(
            slug: string,
        ) {
            checkObjectType('slug', slug, 'string');
            if (typeof this.id === 'number') {
                await serverProxy.organizations.aiFunctionInstances.delete(this.id, slug);
                return;
            }
            throw new DataError('Organization is not created');
        },
    },
});

Object.defineProperties(Organization.prototype.enableAIFunctionInstance, {
    implementation: {
        writable: false,
        enumerable: false,
        value: async function implementation(
            slug: string,
        ) {
            checkObjectType('slug', slug, 'string');
            if (typeof this.id === 'number') {
                const result = await serverProxy.organizations.aiFunctionInstances.enable(this.id, slug);
                return new AIFunctionInstance(result);
            }
            throw new DataError('Organization is not created');
        },
    },
});

Object.defineProperties(Organization.prototype.disableAIFunctionInstance, {
    implementation: {
        writable: false,
        enumerable: false,
        value: async function implementation(
            slug: string,
        ) {
            checkObjectType('slug', slug, 'string');
            if (typeof this.id === 'number') {
                const result = await serverProxy.organizations.aiFunctionInstances.disable(this.id, slug);
                return new AIFunctionInstance(result);
            }
            throw new DataError('Organization is not created');
        },
    },
});

Object.defineProperties(Organization.prototype.setDefaultAIFunctionInstance, {
    implementation: {
        writable: false,
        enumerable: false,
        value: async function implementation(
            slug: string,
        ) {
            checkObjectType('slug', slug, 'string');
            if (typeof this.id === 'number') {
                const result = await serverProxy.organizations.aiFunctionInstances.setDefault(this.id, slug);
                return new AIFunctionInstance(result);
            }
            throw new DataError('Organization is not created');
        },
    },
});

Object.defineProperties(Organization.prototype.probeHttpMicroservice, {
    implementation: {
        writable: false,
        enumerable: false,
        value: async function implementation(
            fields: Parameters<typeof Organization.prototype.probeHttpMicroservice>[0],
        ) {
            checkObjectType('fields', fields, null, { cls: Object, name: 'Object' });
            if (typeof this.id === 'number') {
                const payload: {
                    api_url: string;
                    http_timeout_seconds?: number;
                    api_key?: string;
                    instance_slug?: string;
                } = {
                    api_url: String(fields?.apiUrl || '').trim(),
                };
                if (typeof fields?.httpTimeoutSeconds === 'number' && Number.isFinite(fields.httpTimeoutSeconds)) {
                    payload.http_timeout_seconds = fields.httpTimeoutSeconds;
                }
                if (typeof fields?.apiKey === 'string' && fields.apiKey && fields.apiKey !== '***PRESERVED***') {
                    payload.api_key = fields.apiKey;
                }
                if (typeof fields?.instanceSlug === 'string' && fields.instanceSlug.trim()) {
                    payload.instance_slug = fields.instanceSlug.trim();
                }
                return serverProxy.organizations.aiFunctionInstances.probe(this.id, payload);
            }
            throw new DataError('Organization is not created');
        },
    },
});
