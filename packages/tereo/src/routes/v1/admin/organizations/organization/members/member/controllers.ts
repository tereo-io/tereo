import { getDefaultOrganizationId } from "../../../../../../../utils/defaultOrganization.js";
import { OrgMemberRole } from "../../../../../../../../prisma/generated/client/index.js";
import { assertNotIntegrationAccount } from "../../../../../../../utils/integrations.js";
import { revokeOrganizationGrantsTx } from "../../../../../../../utils/bucketGrants.js";
import { formatOrganizationMember } from "../../../../../../../utils/transformers.js";
import { recordSessionsRevoked } from "../../../../../../../utils/sessionEvents.js";
import { endOrganizationSessions } from "../../../../../../../utils/sessions.js";
import { MemberUserIdParamSchema, UpdateMemberRoleSchema } from "./schemas.js";
import type { Prisma } from "../../../../../../../utils/db/prisma.js";
import { validateUser } from "../../../../../../../utils/auth.js";
import db from "../../../../../../../utils/db/index.js";
import { OrgIdParamSchema } from "../../../schemas.js";
import type { Request, Response } from "express";
import {
  notifyBucketAccessChanged,
  notifyOrgMembershipChanged,
} from "../../../../../../../websocket/emitters/index.js";
import {
  lockOrgOwners,
  requireOrgRole,
} from "../../../../../../../utils/orgRoleAuth.js";
import {
  validateBody,
  validateParams,
} from "../../../../../../../utils/validateReq.js";
import {
  computeChanges,
  emitTx,
  logAuditTx,
} from "../../../../../../../utils/outbox.js";
import {
  ConflictError,
  ForbiddenError,
} from "../../../../../../../utils/errors.js";

/** An organization keeps at least one owner while it has members. */
const assertOwnerRemains = async (
  tx: Prisma.TransactionClient,
  orgId: string,
  userId: string
) => {
  const owners = await tx.organizationMember.count({
    where: { organizationId: orgId, memberRole: "owner", NOT: { userId } },
  });
  if (owners === 0) {
    throw new ConflictError(
      "An organization must keep at least one owner; make another member an owner first"
    );
  }
};

export const removeMember = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id: orgId } = validateParams(OrgIdParamSchema, req);
  const { userId } = validateParams(MemberUserIdParamSchema, req);

  const callerRole = await requireOrgRole("admin", req, orgId);

  await db.organizations.get(orgId);
  await assertNotIntegrationAccount(userId);
  const revokedBuckets = await db.$transaction(async (tx) => {
    await db.users.lockAuthority(userId, tx);
    await lockOrgOwners(tx, orgId);
    const removed = await db.organizations.removeMember(orgId, userId, tx);
    if (callerRole === "admin" && removed.memberRole === "owner") {
      throw new ForbiddenError(
        "Only organization owners can remove other owners"
      );
    }
    if (removed.memberRole === "owner") {
      await assertOwnerRemains(tx, orgId, userId);
    }
    // Org-scoped roles grant nothing without the membership; leaving them
    // would hand them back if the user were ever re-added.
    await tx.userRole.deleteMany({ where: { userId, organizationId: orgId } });
    await logAuditTx(tx, {
      auth,
      organizationId: orgId,
      action: "DELETE",
      entityType: "OrganizationMember",
      entityId: removed.id,
      entityName: removed.user.email,
      metadata: { userId, memberRole: removed.memberRole },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.organization.member-removed",
      entityType: "OrganizationMember",
      entityId: removed.id,
      data: {
        organizationId: orgId,
        userId,
        email: removed.user.email,
        memberRole: removed.memberRole,
      },
    });
    // Like the roles, a grant on the organization's buckets would come back
    // with a re-added membership.
    return await revokeOrganizationGrantsTx(tx, auth, orgId, userId);
  });

  // Tokens and SSO sessions bound to this organization end with the
  // membership.
  await endOrganizationSessions(
    userId,
    orgId,
    recordSessionsRevoked(auth, await db.users.get(userId))
  );

  notifyOrgMembershipChanged(userId, orgId);
  for (const bucketName of revokedBuckets) {
    notifyBucketAccessChanged([userId], bucketName);
  }

  res.status(204).send();
};

export const updateMemberRole = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id: orgId } = validateParams(OrgIdParamSchema, req);
  const { userId } = validateParams(MemberUserIdParamSchema, req);
  const callerRole = await requireOrgRole("admin", req, orgId);
  const body = validateBody(UpdateMemberRoleSchema, req);
  await assertNotIntegrationAccount(userId);

  // Admins cannot change an owner's role or make anyone (themselves
  // included) an owner — only owners or platform admins can.
  if (callerRole === "admin" && body.memberRole === "owner") {
    throw new ForbiddenError(
      "Only organization owners can make someone an owner"
    );
  }
  await db.organizations.get(orgId);

  const member = await db.$transaction(async (tx) => {
    // An owner or admin tier is authority a credential reset checks for.
    await db.users.lockAuthority(userId, tx);
    await lockOrgOwners(tx, orgId);
    const { previousRole, member: updated } =
      await db.organizations.updateMemberRole(
        orgId,
        userId,
        body.memberRole as OrgMemberRole,
        tx
      );
    if (callerRole === "admin" && previousRole === "owner") {
      throw new ForbiddenError(
        "Only organization owners can change an owner's role"
      );
    }
    if (previousRole === "owner" && updated.memberRole !== "owner") {
      await assertOwnerRemains(tx, orgId, userId);
    }
    await logAuditTx(tx, {
      auth,
      organizationId: orgId,
      action: "UPDATE",
      entityType: "OrganizationMember",
      entityId: updated.id,
      entityName: updated.user.email,
      changes: computeChanges(
        { memberRole: previousRole },
        { memberRole: updated.memberRole }
      ),
      metadata: { userId },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.organization.member-updated",
      entityType: "OrganizationMember",
      entityId: updated.id,
      data: {
        organizationId: orgId,
        userId,
        email: updated.user.email,
        memberRole: updated.memberRole,
        previousMemberRole: previousRole,
      },
    });
    return updated;
  });
  notifyOrgMembershipChanged(userId, orgId);
  res.json(formatOrganizationMember(member));
};
