import type { OrganizationChangePayload } from "../types.js";
import { getIO } from "./permissionEmitters.js";
import { userRoom } from "./sessionEmitters.js";
import { logger } from "../../utils/logger.js";
import db from "../../utils/db/index.js";

/**
 * Reaches every socket of the users, whichever organization its token was
 * issued for: the client refreshes its token and organization list.
 */
const emitOrgChangeToUsers = (
  userIds: string[],
  payload: OrganizationChangePayload
) => {
  if (userIds.length === 0) return;
  getIO().to(userIds.map(userRoom)).emit("auth:organization:changed", payload);
  logger.debug(
    { payload, userCount: userIds.length },
    "Emitted organization change"
  );
};

/** The user joined or left the organization, or their member tier changed. */
export const notifyOrgMembershipChanged = (
  userId: string,
  organizationId: string
) => {
  emitOrgChangeToUsers([userId], {
    reason: "membership_changed",
    organizationId,
    timestamp: Date.now(),
  });
};

/** The user's org-scoped roles in the organization changed. */
export const notifyOrgRolesChanged = (
  userId: string,
  organizationId: string
) => {
  emitOrgChangeToUsers([userId], {
    reason: "roles_changed",
    organizationId,
    timestamp: Date.now(),
  });
};

/**
 * Call after the organization's tokens are revoked, so a refresh the event
 * prompts cannot outrun the revocation, and before its sockets are closed,
 * so they still receive it.
 */
export const notifyOrgDeactivated = async (organizationId: string) => {
  const members = await db.organizations.getMembers(organizationId);
  emitOrgChangeToUsers(
    members.map((m) => m.userId),
    { reason: "org_deactivated", organizationId, timestamp: Date.now() }
  );
};
