import { ClientType, UserType } from "../../prisma/generated/client/index.js";
import { toOrgRef, toServiceRef, toUserRef, type OrgRef } from "./refs.js";
import type { IntegrationRow, ServiceWithClient } from "./db/services.js";
import { previousSecretExpiry } from "./webhookSigning.js";
import { maskCustomHeaders } from "./webhookHeaders.js";
import db from "./db/index.js";

export const formatClient = (
  client: {
    id: string;
    clientId: string;
    clientType: ClientType;
    name: string;
    redirectUris: string[];
    postLogoutRedirectUris: string[];
    scopes: string[];
    grantTypes: string[];
    audience: string[];
    consentRequired: boolean;
    trustedCoreScopes: string[];
    provisioned: boolean;
    ownerId: string;
    organizationId: string | null;
    createdAt: Date;
    updatedAt: Date;
    organization?: OrgRef | null;
    owner?: {
      id: string;
      email: string;
      name: string | null;
      userType?: UserType;
    };
    serviceAccountUser?: {
      id: string;
      email: string;
      name: string | null;
      userType?: UserType;
    } | null;
    service?: { id: string; slug: string; name: string } | null;
  },
  includeSecret = false,
  plainSecret?: string
) => {
  const result: Record<string, unknown> = {
    id: client.id,
    clientId: client.clientId,
    clientType: client.clientType,
    name: client.name,
    redirectUris: client.redirectUris,
    postLogoutRedirectUris: client.postLogoutRedirectUris,
    scopes: client.scopes,
    grantTypes: client.grantTypes,
    audience: client.audience,
    consentRequired: client.consentRequired,
    trustedCoreScopes: client.trustedCoreScopes,
    provisioned: client.provisioned,
    ownerId: client.ownerId,
    organizationId: client.organizationId,
    // Set when the client is a service's: core refuses to edit, delete or
    // regenerate it here (it is managed under /admin/services).
    service: client.service
      ? {
          id: client.service.id,
          slug: client.service.slug,
          name: client.service.name,
        }
      : null,
    createdAt: client.createdAt.toISOString(),
    updatedAt: client.updatedAt.toISOString(),
  };

  // Only where the relation was loaded: event payloads leave it out.
  if (client.organization !== undefined) {
    result.organization = toOrgRef(client.organization);
  }

  if (client.owner) {
    result.owner = {
      id: client.owner.id,
      email: client.owner.email,
      name: client.owner.name,
      userType: client.owner.userType,
    };
  }

  if (client.serviceAccountUser) {
    result.serviceAccountUser = {
      id: client.serviceAccountUser.id,
      email: client.serviceAccountUser.email,
      name: client.serviceAccountUser.name,
      userType: client.serviceAccountUser.userType,
    };
  }

  if (includeSecret && plainSecret) {
    result.clientSecret = plainSecret;
  }

  return result;
};

export const formatUser = (user: {
  id: string;
  email: string;
  name: string | null;
  isActive: boolean;
  userType: UserType;
  passwordHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  isActive: user.isActive,
  userType: user.userType,
  hasPassword: user.passwordHash !== null,
  createdAt: user.createdAt.toISOString(),
  updatedAt: user.updatedAt.toISOString(),
});

export const formatOrganization = (
  org: Awaited<ReturnType<typeof db.organizations.get>>
) => {
  if (!org) return null;
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    code: org.code,
    isDefault: org.isDefault,
    isActive: org.isActive,
    archivedAt: org.archivedAt ? org.archivedAt.toISOString() : null,
    memberCount: org._count.members,
    createdAt: org.createdAt.toISOString(),
    updatedAt: org.updatedAt.toISOString(),
  };
};

export const formatOrganizationMember = (
  member: Awaited<ReturnType<typeof db.organizations.getMembers>>[number]
) => ({
  id: member.id,
  memberRole: member.memberRole,
  createdAt: member.createdAt.toISOString(),
  user: {
    id: member.user.id,
    email: member.user.email,
    name: member.user.name,
    isActive: member.user.isActive,
  },
});

export const formatRole = (role: Awaited<ReturnType<typeof db.roles.get>>) => {
  if (!role) return null;
  return {
    id: role.id,
    name: role.name,
    displayName: role.displayName,
    description: role.description,
    // System roles are declared in code by a service; custom roles by admins.
    isSystem: role.serviceId !== null,
    serviceId: role.serviceId,
    service: toServiceRef(role.service),
    isActive: role.isActive,
    archivedAt: role.archivedAt,
    retiredAt: role.retiredAt,
    requires2fa: role.requires2fa,
    provisioned: role.provisioned,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
    permissions: role.rolePermissions.map((rp) => ({
      id: rp.permission.id,
      name: rp.permission.name,
      displayName: rp.permission.displayName,
      retired: rp.permission.retiredAt !== null,
      orgAssignable: rp.permission.orgAssignable,
    })),
  };
};

const unexpired = (at: Date | null | undefined): Date | null =>
  at && at > new Date() ? at : null;

export const formatService = (service: ServiceWithClient) => ({
  id: service.id,
  slug: service.slug,
  name: service.name,
  namespace: service.namespace,
  isActive: service.isActive,
  provisioned: service.provisioned,
  clientId: service.client?.clientId ?? null,
  serviceAccountUserId: service.client?.serviceAccountUser?.id ?? null,
  serviceAccountUser: toUserRef(service.client?.serviceAccountUser),
  audience: service.client?.audience ?? [],
  // Past its expiry the previous secret is refused (verifyClientSecret), so
  // there is no overlap left to report.
  previousSecretExpiresAt: unexpired(service.client?.previousSecretExpiresAt),
  declarationHash: service.declarationHash,
  declarationVersion: service.declarationVersion,
  declaredAt: service.declaredAt,
  createdBy: service.createdBy,
  creator: toUserRef(service.creator),
  createdAt: service.createdAt,
  updatedAt: service.updatedAt,
});

/**
 * An integration. `roles` are those that count for it: in its organization
 * when it is bound to one, global otherwise.
 */
export const formatIntegration = (integration: IntegrationRow) => {
  const account = integration.client?.serviceAccountUser;
  return {
    id: integration.id,
    slug: integration.slug,
    name: integration.name,
    organizationId: integration.organizationId,
    organization: toOrgRef(integration.organization),
    isActive: integration.isActive,
    provisioned: integration.provisioned,
    clientId: integration.client?.clientId ?? null,
    serviceAccountUserId: account?.id ?? null,
    serviceAccountUser: toUserRef(account),
    roles: (account?.userRoles ?? [])
      .filter((ur) => ur.organizationId === integration.organizationId)
      .map(({ role }) => ({
        id: role.id,
        name: role.name,
        displayName: role.displayName,
        system: role.serviceId !== null,
      })),
    audience: integration.client?.audience ?? [],
    previousSecretExpiresAt: unexpired(
      integration.client?.previousSecretExpiresAt
    ),
    createdBy: integration.createdBy,
    creator: toUserRef(integration.creator),
    createdAt: integration.createdAt,
    updatedAt: integration.updatedAt,
  };
};

type WebhookEndpointRow = Awaited<
  ReturnType<typeof db.webhookEndpoints.getById>
>;

/**
 * The stored secrets are sealed and never leave core. The current one shows
 * as its hint, unless `revealSecret` gives its plaintext (create and rotate,
 * where it is shown once). Custom header values are always masked.
 */
export const formatWebhookEndpoint = <T extends WebhookEndpointRow>(
  endpoint: T,
  options: { hasDeliveries: boolean; revealSecret?: string }
) => {
  const {
    previousSigningSecret: _previous,
    signingSecretHint,
    ownerService,
    ...rest
  } = endpoint;
  return {
    ...rest,
    ownerService: ownerService && {
      id: ownerService.id,
      slug: ownerService.slug,
      name: ownerService.name,
    },
    signingSecret: options.revealSecret ?? `${signingSecretHint ?? ""}...`,
    creator: toUserRef(endpoint.creator),
    customHeaders: maskCustomHeaders(endpoint.customHeaders),
    previousSecretExpiresAt: previousSecretExpiry(endpoint),
    hasDeliveries: options.hasDeliveries,
  };
};
