import { getDefaultOrganizationId } from "../../../../../../../utils/defaultOrganization.js";
import { notifyUserRolesChanged } from "../../../../../../../websocket/emitters/index.js";
import { assertAdminRemains } from "../../../../../../../utils/adminGuard.js";
import { RemoveRoleUserQuerySchema, UserIdParamSchema } from "./schemas.js";
import { logAuditTx, emitTx } from "../../../../../../../utils/outbox.js";
import { assertMayDisempower } from "../../../../users/user/guards.js";
import { ForbiddenError } from "../../../../../../../utils/errors.js";
import { validateUser } from "../../../../../../../utils/auth.js";
import { RoleIdParamSchema } from "../../../schemas.js";
import db from "../../../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import {
  lockOrgOwners,
  requireOrgRole,
} from "../../../../../../../utils/orgRoleAuth.js";
import {
  validateParams,
  validateQuery,
} from "../../../../../../../utils/validateReq.js";

/**
 * Removes one assignment: the global one, or with `organizationId` the one
 * scoped to that organization, which also takes the organization authority
 * that managing its member roles does (requireOrgRole "admin", and an org
 * admin does not manage an owner). Removing a global assignment needs the
 * caller to hold every permission the user holds, as `PUT /admin/users/:id/roles`
 * does.
 */
export const removeRoleUser = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id: roleId } = validateParams(RoleIdParamSchema, req);
  const { userId } = validateParams(UserIdParamSchema, req);
  const { organizationId = null } = validateQuery(
    RemoveRoleUserQuerySchema,
    req
  );

  const callerOrgRole = organizationId
    ? await requireOrgRole("admin", req, organizationId)
    : null;
  const role = await db.roles.get(roleId);
  const user = await db.users.get(userId);
  // A service's roles are what an admin approved for it (/admin/services).
  if (
    user.oauthClientId &&
    (await db.services.getByClientId(user.oauthClientId))
  ) {
    throw new ForbiddenError(
      "This user is a service account; revoke its access under /admin/services"
    );
  }
  if (!organizationId) {
    await assertMayDisempower(auth, userId, "remove roles from");
  }

  const entityId = [
    roleId,
    userId,
    ...(organizationId ? [organizationId] : []),
  ].join(":");
  const details = { roleId, userId, organizationId, roleName: role.name };

  await db.$transaction(async (tx) => {
    if (organizationId && callerOrgRole === "admin") {
      // Under the lock tier changes take, so the target's tier holds until
      // the write.
      await lockOrgOwners(tx, organizationId);
      const membership = await db.organizations.getMembership(
        organizationId,
        userId,
        tx
      );
      if (membership?.memberRole === "owner") {
        throw new ForbiddenError(
          "Only organization owners can change an owner's roles"
        );
      }
    }
    // Org-scoped assignments never count as administrators, so removing one
    // always passes; the guard still runs, under its lock, for both.
    await assertAdminRemains(
      (a) =>
        organizationId !== null || a.userId !== userId || a.roleId !== roleId,
      tx
    );
    await db.roles.removeUserRole(
      userId,
      roleId,
      organizationId ?? undefined,
      tx
    );
    await logAuditTx(tx, {
      auth,
      ...(organizationId && { organizationId }),
      action: "DELETE",
      entityType: "RoleAssignment",
      entityId,
      entityName: role.name,
      metadata: details,
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.role.user-removed",
      entityType: "RoleAssignment",
      entityId,
      data: details,
    });
  });

  notifyUserRolesChanged(userId);

  res.status(204).send();
};
