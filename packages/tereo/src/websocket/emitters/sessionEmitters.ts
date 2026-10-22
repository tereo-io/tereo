import { getIO } from "./permissionEmitters.js";
import { logger } from "../../utils/logger.js";

/** The room of the sockets connected with a session's (refresh token's) tokens. */
export const sessionRoom = (sessionId: string) => `session:${sessionId}`;
/** The room of the sockets connected with one access token. */
export const tokenRoom = (jti: string) => `token:${jti}`;
/** Every socket of a user. */
export const userRoom = (userId: string) => `user:${userId}`;
/**
 * A user's sockets whose token reaches their account: events naming their
 * sessions and organizations go here, not to `userRoom`.
 */
export const userAccountRoom = (userId: string) => `user:${userId}:account`;
/** A user's sockets whose token reaches core's files: bucket grant changes. */
export const userFilesRoom = (userId: string) => `user:${userId}:files`;
/** The sockets connected with tokens issued for an organization. */
export const orgRoom = (orgId: string) => `org:${orgId}`;
/** A user's sockets connected with tokens issued for an organization. */
export const userOrgRoom = (userId: string, orgId: string) =>
  `user:${userId}:org:${orgId}`;

/**
 * Closes the user's sockets — those of tokens issued for `orgId` when it is
 * given. For a user deactivated, or removed from that organization: every
 * token of theirs there is dead, including ones issued without a session.
 */
export const disconnectUserSockets = (userId: string, orgId?: string) => {
  getIO()
    .in(orgId ? userOrgRoom(userId, orgId) : userRoom(userId))
    .disconnectSockets(true);
};

/** Closes the sockets of tokens issued for a deactivated organization. */
export const disconnectOrganizationSockets = (orgId: string) => {
  getIO().in(orgRoom(orgId)).disconnectSockets(true);
};

/**
 * Tells the user's clients the sessions were revoked, then closes the
 * sockets that connected with those sessions' tokens: a socket is
 * authenticated once, at the handshake, and would otherwise keep receiving
 * events. The client reconnects with a fresh token if it still has one.
 * A socket outside the account room hears only of its own session.
 */
export const notifySessionsRevoked = (userId: string, sessionIds: string[]) => {
  if (sessionIds.length === 0) return;

  const io = getIO();
  const timestamp = Date.now();

  for (const sessionId of sessionIds) {
    io.to([userAccountRoom(userId), sessionRoom(sessionId)]).emit(
      "auth:session:revoked",
      { sessionId, timestamp }
    );
  }
  io.in(sessionIds.map(sessionRoom)).disconnectSockets(true);
  logger.debug(
    `Emitted ${sessionIds.length} sessions revoked to user ${userId}`
  );
};

/** Closes the sockets that connected with these (revoked) access tokens. */
export const disconnectTokenSockets = (jtis: string[]) => {
  if (jtis.length === 0) return;
  getIO().in(jtis.map(tokenRoom)).disconnectSockets(true);
};
