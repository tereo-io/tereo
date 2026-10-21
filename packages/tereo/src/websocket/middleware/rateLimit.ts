import type { AuthenticatedSocket } from "../types.js";
import { logger } from "../../utils/logger.js";

/** Messages a socket may send at once; `auth:ping` is the only one handled. */
const BURST = 10;
const REFILL_PER_SECOND = 1;
/**
 * How far past empty the bucket may go before the socket is closed: a
 * client sending faster than the refill for long, not one burst too many.
 */
const ABUSE_DEPTH = 30;

/**
 * A token bucket over the socket's incoming messages. A message over the
 * limit is dropped, but still drains the bucket, so a client that keeps
 * sending sinks below empty and is disconnected.
 */
export const limitMessages = (socket: AuthenticatedSocket) => {
  let tokens = BURST;
  let refilledAt = Date.now();

  socket.use((_packet, next) => {
    const now = Date.now();
    tokens = Math.min(
      BURST,
      tokens + ((now - refilledAt) / 1000) * REFILL_PER_SECOND
    );
    refilledAt = now;
    tokens -= 1;
    if (tokens >= 0) {
      next();
      return;
    }
    if (tokens <= -ABUSE_DEPTH) {
      logger.warn(
        { userId: socket.data.userId },
        "WebSocket client over its message rate; disconnecting"
      );
      socket.disconnect(true);
    }
  });
};
