import { bearerToken, verifyAccessToken } from "../../utils/tokens.js";
import { checkAccessToken } from "../../utils/sessions.js";
import { allowsArea } from "../../utils/coreAccess.js";
import { logger } from "../../utils/logger.js";
import type { Socket } from "socket.io";

interface ExtendedError extends Error {
  data?: unknown;
}

const extractAccessToken = (socket: Socket): string | null => {
  if (socket.handshake.auth?.token) {
    return socket.handshake.auth.token as string;
  }

  return bearerToken(socket.handshake.headers.authorization);
};

export const authenticateSocket = async (
  socket: Socket,
  next: (err?: ExtendedError) => void
) => {
  try {
    const token = extractAccessToken(socket);
    if (!token) {
      return next(new Error("No access token provided"));
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

    next();
  } catch (error) {
    logger.error({ err: error }, "WebSocket authentication error");
    next(new Error("Authentication failed"));
  }
};
