import { bearerToken, verifyAccessToken } from "../../utils/tokens.js";
import { checkAccessToken } from "../../utils/sessions.js";
import { allowsArea } from "../../utils/coreAccess.js";
import { logger } from "../../utils/logger.js";
import type { Socket } from "socket.io";

interface ExtendedError extends Error {
  data?: unknown;
}

/** Far above any token core issues; a longer one is not worth verifying. */
const MAX_TOKEN_LENGTH = 8 * 1024;

/** `auth.token`, else the Authorization header's — whatever the client sent. */
const extractAccessToken = (socket: Socket): unknown =>
  socket.handshake.auth?.token ??
  bearerToken(socket.handshake.headers.authorization);

export const authenticateSocket = async (
  socket: Socket,
  next: (err?: ExtendedError) => void
) => {
  try {
    const token = extractAccessToken(socket);
    if (!token) {
      return next(new Error("No access token provided"));
    }
    if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) {
      return next(new Error("Invalid access token"));
    }

    const payload = verifyAccessToken(token);
    if (!payload) {
      return next(new Error("Invalid or expired access token"));
    }

    const check = await checkAccessToken(payload.jti, payload.client_id);
    if (!check.active) return next(new Error(check.reason));
    if (check.isClientToken) {
      return next(new Error("Invalid token subject"));
    }
    // The socket carries the user's own account events.
    if (!allowsArea(check.access, ["account", "events"])) {
      return next(new Error("This token is not issued for core's API"));
    }
    const { user, token: stored } = check;

    socket.data.userId = user.id;
    socket.data.email = user.email;
    socket.data.jti = payload.jti;
    socket.data.sid = stored.refreshTokenId ?? null;
    socket.data.exp = payload.exp;
    socket.data.orgId = stored.organizationId ?? null;
    socket.data.clientId = payload.client_id;
    // A token delegated only `core:events` hears of no more than its scopes
    // would let it read: permission changes and its own session's end.
    socket.data.accountEvents = allowsArea(check.access, "account");
    socket.data.filesEvents = allowsArea(check.access, "files");

    next();
  } catch (error) {
    logger.warn({ err: error }, "WebSocket authentication error");
    next(new Error("Authentication failed"));
  }
};
