import { getDefaultOrganizationId } from "../../../../../../../../utils/defaultOrganization.js";
import { assertOrgAssignableRoles } from "../../../../../../../../utils/orgRoleAssignment.js";
import { notifyOrgRolesChanged } from "../../../../../../../../websocket/emitters/index.js";
import { emitTx, logAuditTx } from "../../../../../../../../utils/outbox.js";
import { validateUser } from "../../../../../../../../utils/auth.js";
import db from "../../../../../../../../utils/db/index.js";
import { OrgIdParamSchema } from "../../../../schemas.js";
import { MemberUserIdParamSchema } from "../schemas.js";
import { SetMemberRolesSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  lockOrgOwners,
  requireOrgRole,
} from "../../../../../../../../utils/orgRoleAuth.js";
import {
  validateBody,
  validateParams,
} from "../../../../../../../../utils/validateReq.js";
import {
  ForbiddenError,
  NotFoundError,
} from "../../../../../../../../utils/errors.js";

export const getMemberOrgRoles = async (req: Request, res: Response) => {
  const { id: orgId } = validateParams(OrgIdParamSchema, req);
  const { userId } = validateParams(MemberUserIdParamSchema, req);

  await requireOrgRole("member", req, orgId);

  // getAny: archived organizations stay readable, like their member list.
  await db.organizations.getAny(orgId);
  const membership = await db.organizations.getMembership(orgId, userId);
  if (!membership) {
    throw new NotFoundError("User is not a member of this organization");
  }

  const userRoles = await db.organizations.getMemberRoles(orgId, userId);
  res.json({
    organizationId: orgId,
    userId,
    roles: userRoles.map((ur) => ({
      id: ur.role.id,
      name: ur.role.name,
      displayName: ur.role.displayName,
      expiresAt: ur.expiresAt,
    })),
  });
};

export const setMemberOrgRoles = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id: orgId } = validateParams(OrgIdParamSchema, req);
  const { userId } = validateParams(MemberUserIdParamSchema, req);
  const callerRole = await requireOrgRole("admin", req, orgId);
  const body = validateBody(SetMemberRolesSchema, req);
  const roleIds = [...new Set(body.roleIds)];

  await db.organizations.get(orgId);

  const userRoles = await db.$transaction(async (tx) => {
    // Under the lock removeMember and tier changes take, so the membership
    // and its tier hold until the write.
    await lockOrgOwners(tx, orgId);
    const membership = await db.organizations.getMembership(orgId, userId, tx);
    if (!membership) {
      throw new NotFoundError("User is not a member of this organization");
    }
    // As with member tiers: an org admin does not manage an owner.
    if (callerRole === "admin" && membership.memberRole === "owner") {
      throw new ForbiddenError(
        "Only organization owners can change an owner's roles"
      );
    }

    // Read in the transaction, and only the roles new as of this read are
    // created: a held role removed concurrently is not put back unchecked.
    // A held role stays whatever its state (archived, retired).
    const held = new Set(
      (await db.organizations.getMemberRoles(orgId, userId, tx)).map(
        (ur) => ur.roleId
      )
    );
    const added = roleIds.filter((roleId) => !held.has(roleId));
    await assertOrgAssignableRoles(auth, orgId, added, new Set());
    const result = await db.organizations.setMemberRoles(
      orgId,
      userId,
      roleIds,
      tx,
      new Set(added)
    );
    await logAuditTx(tx, {
      auth,
      organizationId: orgId,
      action: "UPDATE",
      entityType: "OrganizationMember",
      entityId: membership.id,
      entityName: membership.user.email,
      metadata: { action: "roles_changed", userId, roleIds },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.organization.member-roles-changed",
      entityType: "OrganizationMember",
      entityId: membership.id,
      data: {
        organizationId: orgId,
        userId,
        email: membership.user.email,
        roleIds,
      },
    });
    return result;
  });

  notifyOrgRolesChanged(userId, orgId);
  res.json({
    organizationId: orgId,
    userId,
    roles: userRoles.map((ur) => ({
      id: ur.role.id,
      name: ur.role.name,
      displayName: ur.role.displayName,
      expiresAt: ur.expiresAt,
    })),
  });
};
