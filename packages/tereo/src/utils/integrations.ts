import { assertCanGrant, globalGrantablePermissions } from "./grants.js";
import { getDefaultOrganizationId } from "./defaultOrganization.js";
import { UserType } from "../../prisma/generated/client/index.js";
import { assertOrgAssignableRoles } from "./orgRoleAssignment.js";
import type { AuthContext } from "../middleware/auth.js";
import type { IntegrationRow } from "./db/services.js";
import { CORE_SERVICE } from "../definitions/index.js";
import { prisma, type Prisma } from "./db/prisma.js";
import { serviceAccountEmail } from "./services.js";
import { emitTx, logAuditTx } from "./outbox.js";
import db from "./db/index.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RoleNotAllowedForIntegrationError,
  UnprocessableEntityError,
} from "./errors.js";

type Tx = Prisma.TransactionClient;

export interface IntegrationActor {
  userId: string;
  email: string | null;
}

/** An admin, whose grants are bounded by what they hold. */
export type IntegrationApprover = IntegrationActor &
  Pick<AuthContext, "permissions" | "ceiling" | "organizationId">;

export interface CreateIntegrationInput {
  slug: string;
  name: string;
  /** Org-bound when set: its tokens carry this org_id. Fixed once set. */
  organizationId: string | null;
  clientId: string;
  clientSecretHash: string;
  provisioned?: boolean;
  /** Added to the audit entry's metadata. */
  auditMetadata?: Record<string, unknown>;
}

/** The rows an integration spans, as its writes need them. */
export interface IntegrationRef {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
  organizationId: string | null;
  clientRowId: string;
  accountUserId: string;
}

export const integrationRef = (row: IntegrationRow): IntegrationRef => {
  const accountUserId = row.client?.serviceAccountUser?.id;
  if (!row.client || !accountUserId) {
    throw new Error(
      `Integration ${row.slug} has no client or service account; its rows are inconsistent`
    );
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    isActive: row.isActive,
    organizationId: row.organizationId,
    clientRowId: row.client.id,
    accountUserId,
  };
};

const emitIntegration = (
  tx: Tx,
  eventType:
    | "core.integration.created"
    | "core.integration.updated"
    | "core.integration.deactivated",
  integration: Pick<IntegrationRef, "id" | "slug" | "organizationId">,
  data: Record<string, unknown>
) =>
  emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType,
    entityType: "Integration",
    entityId: integration.id,
    data: {
      id: integration.id,
      slug: integration.slug,
      organizationId: integration.organizationId,
      ...data,
    },
  });

/**
 * Add an integration: its confidential client (client_credentials only, bound
 * to the organization if any), the service-account user it acts as, its
 * `core.services` row, and for an org-bound one the account's membership.
 */
export const createIntegrationTx = async (
  tx: Tx,
  input: CreateIntegrationInput,
  actor: IntegrationActor
): Promise<IntegrationRow> => {
  const { slug, name, organizationId } = input;
  if (await tx.service.findUnique({ where: { slug } })) {
    throw new ConflictError(
      `A service or integration with slug "${slug}" already exists`
    );
  }
  const email = serviceAccountEmail(slug);
  if (await tx.user.findUnique({ where: { email } })) {
    throw new ConflictError(`A user with email "${email}" already exists`);
  }
  if (organizationId) {
    try {
      await db.organizations.get(organizationId, tx);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      throw new BadRequestError(
        "unknown_organization",
        `No organization with id ${organizationId}`
      );
    }
  }

  const client = await tx.oAuthClient.create({
    data: {
      clientId: input.clientId,
      clientSecret: input.clientSecretHash,
      clientType: "confidential",
      name,
      redirectUris: [],
      scopes: [],
      grantTypes: ["client_credentials"],
      audience: [],
      ownerId: actor.userId,
      organizationId,
      provisioned: input.provisioned,
    },
  });
  const user = await tx.user.create({
    data: {
      email,
      name,
      passwordHash: "!",
      userType: UserType.service_account,
      oauthClientId: client.id,
    },
  });
  const created = await tx.service.create({
    data: {
      slug,
      name,
      kind: "integration",
      namespace: null,
      organizationId,
      clientId: client.id,
      createdBy: actor.userId,
      provisioned: input.provisioned,
    },
  });
  if (organizationId) {
    await db.organizations.addMember(organizationId, user.id, undefined, tx);
  }

  await logAuditTx(tx, {
    auth: actor,
    action: "CREATE",
    entityType: "Integration",
    entityId: created.id,
    entityName: slug,
    metadata: {
      name,
      organizationId,
      clientId: input.clientId,
      ...(input.provisioned && { provisioned: true }),
      ...input.auditMetadata,
    },
  });
  await emitIntegration(tx, "core.integration.created", created, { name });
  return db.services.getIntegration(created.id, tx);
};

/**
 * Rename, deactivate or reactivate. A deactivated integration's account is
 * inactive, so no token is minted for it, and its tokens are revoked.
 */
export const updateIntegrationTx = async (
  tx: Tx,
  existing: IntegrationRef,
  body: { name?: string; isActive?: boolean },
  actor: IntegrationActor,
  auditMetadata?: Record<string, unknown>
): Promise<IntegrationRow> => {
  await tx.service.update({
    where: { id: existing.id },
    data: { name: body.name, isActive: body.isActive },
  });
  if (body.isActive !== undefined) {
    await tx.user.update({
      where: { id: existing.accountUserId },
      data: { isActive: body.isActive },
    });
  }
  if (body.name !== undefined) {
    await tx.oAuthClient.update({
      where: { id: existing.clientRowId },
      data: { name: body.name },
    });
  }
  if (body.isActive === false) {
    await db.accessTokens.revokeByClientId(existing.clientRowId, tx);
  }
  const after = await db.services.getIntegration(existing.id, tx);
  await logAuditTx(tx, {
    auth: actor,
    action: "UPDATE",
    entityType: "Integration",
    entityId: after.id,
    entityName: after.slug,
    changes: {
      ...(body.name !== undefined && {
        name: { old: existing.name, new: after.name },
      }),
      ...(body.isActive !== undefined && {
        isActive: { old: existing.isActive, new: after.isActive },
      }),
    },
    ...(auditMetadata && { metadata: auditMetadata }),
  });
  await emitIntegration(
    tx,
    existing.isActive && !after.isActive
      ? "core.integration.deactivated"
      : "core.integration.updated",
    after,
    { name: after.name, isActive: after.isActive }
  );
  return after;
};

const sameSet = (a: string[], b: string[]) => {
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((v) => set.has(v));
};

const isApprover = (
  actor: IntegrationActor | IntegrationApprover
): actor is IntegrationApprover => "permissions" in actor;

/**
 * Make `roleIds` the integration's roles: org roles in its organization when
 * org-bound (org-assignable custom roles only), global roles otherwise. An
 * approver must hold what is newly granted; a plain actor (provisioning, as
 * the system user) is not checked for that. Its tokens are revoked when the
 * roles change. Returns whether they did. No role carrying `admin`, ever.
 */
export const setIntegrationRolesTx = async (
  tx: Tx,
  integration: IntegrationRef,
  roleIds: string[],
  actor: IntegrationActor | IntegrationApprover,
  auditMetadata?: Record<string, unknown>
): Promise<boolean> => {
  const wanted = [...new Set(roleIds)];
  const orgId = integration.organizationId;
  const heldIds = (
    await tx.userRole.findMany({
      where: { userId: integration.accountUserId, organizationId: orgId },
      select: { roleId: true },
    })
  ).map((ur) => ur.roleId);
  const held = new Set(heldIds);
  const added = wanted.filter((id) => !held.has(id));

  const carryingAdmin = (await db.roles.getByIds(wanted, tx)).filter((role) =>
    db.roles.grantedPermissionNames([role]).includes("admin")
  );
  if (carryingAdmin.length > 0) {
    throw new RoleNotAllowedForIntegrationError(
      `Integrations can't hold a role carrying the admin permission: ${carryingAdmin
        .map((r) => r.name)
        .join(", ")}`
    );
  }

  if (orgId) {
    // Provisioning grants as one holding everything; the other rules stand.
    const approver = isApprover(actor)
      ? actor
      : { ...actor, permissions: ["admin"], organizationId: orgId };
    await assertOrgAssignableRoles(approver, orgId, wanted, held, tx);
  } else {
    const roles = await db.roles.getByIds(added, tx);
    const found = new Set(roles.map((r) => r.id));
    const missing = added.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new BadRequestError(
        "unknown_role",
        `Roles not found, archived or retired: ${missing.join(", ")}`
      );
    }
    if (isApprover(actor)) {
      assertCanGrant(
        await globalGrantablePermissions(actor, tx),
        db.roles.grantedPermissionNames(roles)
      );
    }
  }

  if (sameSet(heldIds, wanted)) return false;
  const creatable = new Set(added);
  if (orgId) {
    await db.organizations.setMemberRoles(
      orgId,
      integration.accountUserId,
      wanted,
      tx,
      creatable
    );
  } else {
    await db.roles.setUserRoles(
      integration.accountUserId,
      wanted,
      tx,
      creatable
    );
  }
  await db.accessTokens.revokeByClientId(integration.clientRowId, tx);

  await logAuditTx(tx, {
    auth: actor,
    action: "UPDATE",
    entityType: "Integration",
    entityId: integration.id,
    entityName: integration.slug,
    metadata: {
      action: "roles_changed",
      organizationId: orgId,
      roleIds: wanted,
      ...auditMetadata,
    },
  });
  await emitIntegration(tx, "core.integration.updated", integration, {
    roleIds: wanted,
  });
  return true;
};

/**
 * Make `slugs` the services that may introspect the integration's tokens
 * (their `aud`). Each must be a service other than core. Its tokens are
 * revoked when the audience changes. Returns whether it did.
 */
export const setIntegrationAudiencesTx = async (
  tx: Tx,
  integration: IntegrationRef,
  slugs: string[],
  actor: IntegrationActor,
  auditMetadata?: Record<string, unknown>
): Promise<boolean> => {
  const audience = [...new Set(slugs)].sort();
  const known = await db.services.findSlugs(audience, tx);
  const invalid = audience.filter(
    (s) => s === CORE_SERVICE.slug || !known.has(s)
  );
  if (invalid.length > 0) {
    throw new UnprocessableEntityError(
      "invalid_audience",
      `Not a service that can be named in an audience: ${invalid.join(", ")}`
    );
  }

  const client = await tx.oAuthClient.findUniqueOrThrow({
    where: { id: integration.clientRowId },
    select: { audience: true },
  });
  if (sameSet(client.audience, audience)) return false;
  await tx.oAuthClient.update({
    where: { id: integration.clientRowId },
    data: { audience },
  });
  await db.accessTokens.revokeByClientId(integration.clientRowId, tx);

  await logAuditTx(tx, {
    auth: actor,
    action: "UPDATE",
    entityType: "Integration",
    entityId: integration.id,
    entityName: integration.slug,
    changes: { audience: { old: client.audience, new: audience } },
    ...(auditMetadata && { metadata: auditMetadata }),
  });
  await emitIntegration(tx, "core.integration.updated", integration, {
    audience,
  });
  return true;
};

/**
 * An integration's membership and org roles are its own, set under
 * /admin/integrations (or by provisioning), not through the organization's
 * member routes.
 */
export const assertNotIntegrationAccount = async (
  userId: string,
  tx: Tx = prisma
) => {
  const integration = await tx.service.findFirst({
    where: {
      kind: "integration",
      client: { serviceAccountUser: { id: userId } },
    },
    select: { id: true },
  });
  if (integration) {
    throw new ForbiddenError(
      "This user is an integration's account; manage it under /admin/integrations"
    );
  }
};
