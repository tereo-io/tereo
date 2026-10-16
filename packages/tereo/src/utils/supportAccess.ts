import { PERMISSIONS } from "../definitions/permissions.js";
import { hasPermission } from "./permissions.js";
import { NotFoundError } from "./errors.js";
import db from "./db/index.js";

/**
 * Whether the user may select the organization at login: it is active and
 * unarchived, and they are a member of it or hold
 * `organizations.support-access` through their global roles. `support` marks
 * a selection made without a membership.
 */
export const maySelectOrganization = async (
  userId: string,
  organizationId: string
): Promise<{ allowed: boolean; support: boolean }> => {
  const org = await db.organizations.get(organizationId).catch((err) => {
    if (err instanceof NotFoundError) return null;
    throw err;
  });
  if (!org?.isActive) return { allowed: false, support: false };
  if (await db.organizations.getMembership(organizationId, userId)) {
    return { allowed: true, support: false };
  }
  const allowed = hasPermission(
    await db.roles.getUserPermissions(userId, null),
    PERMISSIONS.ORGANIZATIONS.SUPPORT_ACCESS
  );
  return { allowed, support: allowed };
};
