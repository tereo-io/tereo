import { OrgMemberRole } from "../../prisma/generated/client/index.js";
import { hasPermission } from "./permissions.js";
import { ForbiddenError } from "./errors.js";
import type { Prisma } from "./db/prisma.js";
import type { Request } from "express";
import db from "./db/index.js";

export type MinOrgRole = "member" | "admin" | "owner";

const ROLE_LEVEL: Record<OrgMemberRole, number> = {
  member: 0,
  admin: 1,
  owner: 2,
};

const PERMISSION_MAP: Record<MinOrgRole, string> = {
  member: "organizations.read",
  admin: "organizations.write",
  owner: "organizations.write",
};

/**
 * Dual authorization check for organization endpoints.
 *
 * Allows access if the user either:
 * 1. Has the corresponding platform permission (organizations.read/write), OR
 * 2. Is a member of the target org with at least the required memberRole,
 *    and, for anything above "member", the org is active
 *
 * The platform permissions are not org-assignable, so they come only from a
 * global role: no role granted within an organization reaches this bypass.
 *
 * Throws ForbiddenError if neither condition is met.
 */
export async function requireOrgRole(
  minRole: MinOrgRole,
  req: Request,
  orgId: string
): Promise<OrgMemberRole | null> {
  const auth = req.auth;
  if (!auth) throw new ForbiddenError("Authentication required");

  // Platform permission bypass
  const requiredPermission = PERMISSION_MAP[minRole];
  if (hasPermission(auth.permissions, requiredPermission)) return null; // Platform admin — no membership role to return

  // A delegated token's scopes cap the member role's authority as they cap
  // permissions.
  if (auth.ceiling && !hasPermission(auth.ceiling, requiredPermission)) {
    throw new ForbiddenError(
      `This token's scopes do not allow ${requiredPermission}`
    );
  }

  // Check org membership
  const membership = await db.organizations.getMembership(orgId, auth.userId);
  if (!membership) {
    throw new ForbiddenError("You are not a member of this organization");
  }

  const userLevel = ROLE_LEVEL[membership.memberRole];
  const requiredLevel = ROLE_LEVEL[minRole as OrgMemberRole];

  if (userLevel < requiredLevel) {
    throw new ForbiddenError(
      `Insufficient organization role. Required: ${minRole}, yours: ${membership.memberRole}`
    );
  }

  // A deactivated organization is frozen for its members: they may still
  // read it, but only the platform (organizations.write) changes it.
  if (minRole !== "member") {
    const org = await db.organizations.getAny(orgId);
    if (!org.isActive) {
      throw new ForbiddenError(
        "This organization is inactive; its members cannot change it"
      );
    }
  }

  return membership.memberRole;
}

/**
 * Serializes changes to one organization's owners. Taken before the change, so
 * two concurrent removals of its last two owners cannot each count the other
 * as the one that remains, and a target an org admin found not to be an owner
 * cannot become one before the change is written.
 */
export const lockOrgOwners = (tx: Prisma.TransactionClient, orgId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`core:org-owners:${orgId}`}, 0))`;
