import { getDefaultOrganizationId } from "../../../../../utils/defaultOrganization.js";
import { assertAdminRemains } from "../../../../../utils/adminGuard.js";
import { DuplicateRoleSchema, RoleIdParamSchema } from "../schemas.js";
import { SetPermissionsSchema, UpdateRoleSchema } from "./schemas.js";
import { formatRole } from "../../../../../utils/transformers.js";
import type { Prisma } from "../../../../../utils/db/prisma.js";
import { validateUser } from "../../../../../utils/auth.js";
import db from "../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import {
  disconnectTokenSockets,
  notifyRoleDeleted,
  notifyRolePermissionsChanged,
  notifyRoleStatusChanged,
} from "../../../../../websocket/emitters/index.js";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";
import {
  assertCanGrant,
  assertCanTakeAway,
  globalGrantablePermissions,
} from "../../../../../utils/grants.js";
import {
  ValidationError,
  ConflictError,
  ForbiddenError,
  ManagedByProvisioningError,
  RoleNotAllowedForIntegrationError,
} from "../../../../../utils/errors.js";
import {
  logAuditTx,
  computeChanges,
  emitTx,
} from "../../../../../utils/outbox.js";

const refuseProvisioned = (role: { provisioned: boolean }) => {
  if (role.provisioned) throw new ManagedByProvisioningError();
};

/**
 * Integrations never hold `admin` (setIntegrationRolesTx), so a role one holds
 * may not come to grant it. Locks the role, so an integration taking it waits
 * and then sees what it grants.
 */
const refuseAdminForIntegrations = async (
  roleId: string,
  tx: Prisma.TransactionClient
) => {
  await db.roles.lockRoles([roleId], "update", tx);
  const holders = await db.roles.integrationHolderSlugs(roleId, tx);
  if (holders.length > 0) {
    throw new RoleNotAllowedForIntegrationError(
      `Integrations can't hold a role carrying the admin permission, and this one is held by: ${holders.join(", ")}`
    );
  }
};

export const getRole = async (req: Request, res: Response) => {
  const params = validateParams(RoleIdParamSchema, req);

  // getAny: archived roles stay viewable (read-only) for admins.
  const role = await db.roles.getAny(params.id);
  res.json(formatRole(role));
};

export const updateRole = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const params = validateParams(RoleIdParamSchema, req);
  const body = validateBody(UpdateRoleSchema, req);

  const existing = await db.roles.get(params.id);
  refuseProvisioned(existing);
  // A system role is declared in code; only the 2FA policy is the admin's.
  const declared = Object.keys(body).filter((k) => k !== "requires2fa");
  if (existing.serviceId && declared.length > 0) {
    throw new ForbiddenError(
      "System roles are declared in code; only requires2fa can be changed"
    );
  }

  // The 2FA policy guards everything the role grants: only a caller holding
  // all of it may change it (`admin` for core's admin role).
  if (
    body.requires2fa !== undefined &&
    body.requires2fa !== existing.requires2fa
  ) {
    assertCanGrant(
      await globalGrantablePermissions(auth),
      db.roles.grantedPermissionNames([existing])
    );
  }

  // Reactivating hands the role's permissions back to everyone holding it,
  // the caller included: the same as granting them.
  if (body.isActive === true && !existing.isActive) {
    assertCanGrant(
      await globalGrantablePermissions(auth),
      db.roles.grantedPermissionNames([existing])
    );
  }
  if (body.isActive === false && existing.isActive) {
    assertCanTakeAway(
      await globalGrantablePermissions(auth),
      db.roles.grantedPermissionNames([existing])
    );
  }

  if (body.name && body.name !== existing.name) {
    const conflict = await db.roles.getCustomByNameAny(body.name);
    if (conflict) {
      throw new ConflictError(
        conflict.archivedAt
          ? "An archived role with this name already exists"
          : "Role with this name already exists"
      );
    }
  }

  const { role, revokedJtis } = await db.$transaction(async (tx) => {
    if (body.isActive === false && existing.isActive) {
      await assertAdminRemains((a) => a.roleId !== params.id, tx);
    }
    if (body.isActive === true && !existing.isActive) {
      await db.roles.lockRoles([params.id], "update", tx);
      const current = await db.roles.get(params.id, tx);
      if (db.roles.grantedPermissionNames([current]).includes("admin")) {
        await refuseAdminForIntegrations(params.id, tx);
      }
    }
    await db.roles.update(params.id, body, tx);
    const updated = await db.roles.get(params.id, tx);
    // Permissions are read live, so a holder's token from a password-only
    // login would keep working; revoked, its refresh meets the step-up.
    const gains2fa =
      updated.isActive &&
      updated.requires2fa &&
      !(existing.isActive && existing.requires2fa);
    const revokedJtis = gains2fa
      ? await db.accessTokens.revokeWithoutMfa(
          { userRoles: { some: { roleId: params.id } } },
          tx
        )
      : [];
    await logAuditTx(tx, {
      auth,
      action: "UPDATE",
      entityType: "Role",
      entityId: updated.id,
      entityName: updated.name,
      changes: computeChanges(existing, updated),
      ...(revokedJtis.length > 0 && {
        metadata: { accessTokensRevoked: revokedJtis.length },
      }),
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.role.updated",
      entityType: "Role",
      entityId: updated.id,
      data: formatRole(updated) as Record<string, unknown>,
    });
    return { role: updated, revokedJtis };
  });

  disconnectTokenSockets(revokedJtis);

  if (body.isActive !== undefined && body.isActive !== existing.isActive) {
    await notifyRoleStatusChanged(params.id);
    if (!body.isActive) await handleRevokeTokens(params.id);
  }

  res.json(formatRole(role));
};

/**
 * A custom role with the same (unretired) permissions as this one — the
 * starting point for an admin who wants a system role with changes.
 */
export const duplicateRole = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const params = validateParams(RoleIdParamSchema, req);
  const body = validateBody(DuplicateRoleSchema, req);

  const source = await db.roles.get(params.id);
  const existing = await db.roles.getCustomByNameAny(body.name);
  if (existing) {
    throw new ConflictError(
      existing.archivedAt
        ? "An archived role with this name already exists"
        : "Role with this name already exists"
    );
  }
  const granted = source.rolePermissions.filter(
    (rp) => !rp.permission.retiredAt
  );
  assertCanGrant(
    await globalGrantablePermissions(auth),
    granted.map((rp) => rp.permission.name)
  );
  const permissionIds = granted.map((rp) => rp.permissionId);

  const role = await db.$transaction(async (tx) => {
    const created = await db.roles.create(
      {
        name: body.name,
        displayName: body.displayName ?? source.displayName,
        description: body.description ?? source.description ?? undefined,
        requires2fa: source.requires2fa,
      },
      tx
    );
    const withPerms = await db.roles.setPermissions(
      created.id,
      permissionIds,
      tx
    );
    await logAuditTx(tx, {
      auth,
      action: "CREATE",
      entityType: "Role",
      entityId: withPerms.id,
      entityName: withPerms.name,
      metadata: {
        displayName: withPerms.displayName,
        duplicatedFrom: { id: source.id, name: source.name },
        permissionIds,
      },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.role.created",
      entityType: "Role",
      entityId: withPerms.id,
      data: {
        ...(formatRole(withPerms) as Record<string, unknown>),
        duplicatedFrom: source.id,
      },
    });
    return withPerms;
  });

  res.status(201).json(formatRole(role));
};

export const archiveRole = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const params = validateParams(RoleIdParamSchema, req);
  refuseProvisioned(await db.roles.get(params.id));

  const affectedUserIds = await db.roles.getUserIdsByRoleId(params.id);

  await db.$transaction(async (tx) => {
    const archived = await db.roles.archive(params.id, tx);
    await logAuditTx(tx, {
      auth,
      action: "ARCHIVE",
      entityType: "Role",
      entityId: archived.id,
      entityName: archived.name,
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.role.archived",
      entityType: "Role",
      entityId: archived.id,
      data: { id: archived.id, name: archived.name },
    });
  });

  // No token revocation here: archive requires the role to already be
  // deactivated, and deactivation (PATCH isActive=false) revoked tokens.
  // Websocket parity with the old soft delete: role-list-mirroring
  // clients still get the removal signal.
  notifyRoleDeleted(affectedUserIds.map((u) => u.userId));

  res.status(204).send();
};

export const restoreRole = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const params = validateParams(RoleIdParamSchema, req);
  refuseProvisioned(await db.roles.getAny(params.id));

  const restored = await db.$transaction(async (tx) => {
    const result = await db.roles.restore(params.id, tx);
    await logAuditTx(tx, {
      auth,
      action: "RESTORE",
      entityType: "Role",
      entityId: result.id,
      entityName: result.name,
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.role.restored",
      entityType: "Role",
      entityId: result.id,
      data: { id: result.id, name: result.name },
    });
    return result;
  });

  const full = await db.roles.getAny(restored.id);
  res.json(formatRole(full));
};

export const deleteRole = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const params = validateParams(RoleIdParamSchema, req);

  const existing = await db.roles.getAny(params.id);
  refuseProvisioned(existing);
  if (existing.serviceId) {
    throw new ForbiddenError("Cannot delete system role");
  }
  assertCanTakeAway(
    await globalGrantablePermissions(auth),
    db.roles.grantedPermissionNames([existing])
  );

  // Read before the delete: assignments cascade away with the row.
  const affectedUserIds = await db.roles.getUserIdsByRoleId(params.id);

  await db.$transaction(async (tx) => {
    await assertAdminRemains((a) => a.roleId !== params.id, tx);
    await db.roles.remove(params.id, tx);
    await logAuditTx(tx, {
      auth,
      action: "DELETE",
      entityType: "Role",
      entityId: existing.id,
      entityName: existing.name,
      metadata: {
        affectedUsers: affectedUserIds.length,
      },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.role.deleted",
      entityType: "Role",
      entityId: existing.id,
      data: { id: existing.id, name: existing.name },
    });
  });

  await revokeClientTokens(affectedUserIds);
  notifyRoleDeleted(affectedUserIds.map((u) => u.userId));

  res.status(204).send();
};

export const setRolePermissions = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const params = validateParams(RoleIdParamSchema, req);
  const body = validateBody(SetPermissionsSchema, req);

  const existing = await db.roles.get(params.id);
  refuseProvisioned(existing);
  if (existing.serviceId) {
    throw new ForbiddenError(
      "System roles are declared in code; duplicate it as a custom role to change its permissions"
    );
  }

  const nextIds = new Set(body.permissionIds);
  assertCanTakeAway(
    await globalGrantablePermissions(auth),
    db.roles.grantedPermissionNames([
      {
        rolePermissions: existing.rolePermissions.filter(
          (rp) => !nextIds.has(rp.permissionId)
        ),
      },
    ])
  );

  if (body.permissionIds.length > 0) {
    // Retired permissions may stay on a custom role, but not be added to one.
    const permissions = await db.permissions.getByIds(body.permissionIds);
    const foundIds = new Set([
      ...permissions.map((p) => p.id),
      ...existing.rolePermissions.map((rp) => rp.permissionId),
    ]);
    if (body.permissionIds.some((id) => !foundIds.has(id))) {
      const missingIds = body.permissionIds.filter((id) => !foundIds.has(id));
      throw new ValidationError(
        `Permissions not found: ${missingIds.join(", ")}`
      );
    }
    const kept = new Set(existing.rolePermissions.map((rp) => rp.permissionId));
    assertCanGrant(
      await globalGrantablePermissions(auth),
      permissions.filter((p) => !kept.has(p.id)).map((p) => p.name)
    );
  }

  const role = await db.$transaction(async (tx) => {
    await assertOrgAssignableWhileAssignedInOrg(
      tx,
      params.id,
      existing.rolePermissions.map((rp) => rp.permissionId),
      body.permissionIds
    );
    const keepsAdmin = await tx.permission.count({
      where: { id: { in: body.permissionIds }, name: "admin", retiredAt: null },
    });
    if (keepsAdmin) {
      await refuseAdminForIntegrations(params.id, tx);
    } else {
      await assertAdminRemains((a) => a.roleId !== params.id, tx);
    }
    const updated = await db.roles.setPermissions(
      params.id,
      body.permissionIds,
      tx
    );
    await logAuditTx(tx, {
      auth,
      action: "UPDATE",
      entityType: "Role",
      entityId: updated.id,
      entityName: updated.name,
      metadata: {
        action: "permissions_changed",
        permissionIds: body.permissionIds,
      },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.role.permissions-changed",
      entityType: "Role",
      entityId: updated.id,
      data: {
        id: updated.id,
        name: updated.name,
        permissionIds: body.permissionIds,
      },
    });
    return updated;
  });

  await notifyRolePermissionsChanged(params.id);
  await handleRevokeTokens(params.id);

  res.json(formatRole(role));
};

const ORG_LIST_LIMIT = 10;

/**
 * A role held within an organization may grant only org-assignable
 * permissions, so one that is may not gain any other: the assignment would
 * silently hold a permission that grants nothing there. Remove the org-scoped
 * assignments, or use another role, first.
 */
const assertOrgAssignableWhileAssignedInOrg = async (
  tx: Prisma.TransactionClient,
  roleId: string,
  currentIds: string[],
  nextIds: string[]
) => {
  const current = new Set(currentIds);
  const addedIds = nextIds.filter((id) => !current.has(id));
  if (addedIds.length === 0) return;
  const notAssignable = await tx.permission.findMany({
    where: { id: { in: addedIds }, orgAssignable: false, retiredAt: null },
    select: { name: true },
    orderBy: { name: "asc" },
  });
  if (notAssignable.length === 0) return;
  const orgs = await tx.userRole.findMany({
    where: { roleId, organizationId: { not: null } },
    distinct: ["organizationId"],
    select: { organizationId: true },
    orderBy: { organizationId: "asc" },
    take: ORG_LIST_LIMIT + 1,
  });
  if (orgs.length === 0) return;
  const named = orgs.slice(0, ORG_LIST_LIMIT).map((o) => o.organizationId);
  const more = orgs.length > ORG_LIST_LIMIT ? ", and more" : "";
  throw new ConflictError(
    `This role is assigned within organizations (${named.join(", ")}${more}), where it may grant only org-assignable permissions; not org-assignable: ${notAssignable.map((p) => p.name).join(", ")}`,
    "role_assigned_in_org"
  );
};

const handleRevokeTokens = async (roleId: string) => {
  const affectedUserIds = await db.roles.getUserIdsByRoleId(roleId);
  await revokeClientTokens(affectedUserIds);
  return affectedUserIds;
};

/**
 * Revokes the access tokens of service clients holding the role. A human's
 * tokens are left alone: nothing that decides their access is fixed at issue.
 * requireAuth, userinfo and check-permission read permissions from the
 * database on every call, and a refresh mints the next access token with the
 * permissions current then. Revoking the access token would not end the
 * session either, since the refresh token would mint another. The one stale
 * copy is the token's `permissions` claim, which only introspection returns;
 * that is for introspection to answer live, not for revocation to chase.
 */
const revokeClientTokens = async (
  affectedUserIds: { user: { oauthClientId: string | null } }[]
) => {
  const clientIds = new Set(
    affectedUserIds.flatMap((u) =>
      u.user.oauthClientId ? [u.user.oauthClientId] : []
    )
  );
  for (const clientId of clientIds) {
    await db.accessTokens.revokeByClientId(clientId);
  }
};
