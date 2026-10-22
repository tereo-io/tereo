import { closeRedisClient, createRedis, redisKey } from "../utils/redis.js";
import { redisRetryStrategy } from "../utils/redisRetry.js";
import { authenticateSocket } from "./middleware/auth.js";
import { limitMessages } from "./middleware/rateLimit.js";
import { createAdapter } from "@socket.io/redis-adapter";
import { setIO } from "./emitters/permissionEmitters.js";
import type { Server as HttpServer } from "http";
import { logger } from "../utils/logger.js";
import handlers from "./handlers/index.js";
import { Server } from "socket.io";
import { Redis } from "ioredis";
import env from "../env.js";
import {
  orgRoom,
  sessionRoom,
  tokenRoom,
  userAccountRoom,
  userFilesRoom,
  userOrgRoom,
  userRoom,
} from "./emitters/sessionEmitters.js";
import {
  checkAccessToken,
  findInactiveAccessTokens,
} from "../utils/sessions.js";
import type {
  AuthenticatedSocket,
  ServerToClientEvents,
  ClientToServerEvents,
} from "./types.js";

type IOServer = Server<ClientToServerEvents, ServerToClientEvents>;

let io: IOServer | null = null;
let isShuttingDown = false;
let pubClient: Redis | null = null;
let subClient: Redis | null = null;

/**
 * The pub client fails a command after a few retries, so emits during an
 * outage are dropped rather than queued without bound. The sub client waits:
 * a subscribe that failed would never be retried, and the node would stop
 * hearing other nodes' broadcasts.
 */
const createRedisClient = (role: "pub" | "sub"): Redis => {
  const client = createRedis({
    maxRetriesPerRequest: role === "pub" ? 3 : null,
    retryStrategy: (times: number) =>
      redisRetryStrategy(times, "WebSocket Redis"),
  });
  client.on("error", (err) => {
    logger.error({ err }, `Redis ${role} client error`);
  });
  catchDroppedCommands(client, role);
  return client;
};

/** Commands whose promise the Redis adapter (and ioredis's own resubscribe) drops. */
const DROPPED_COMMANDS = [
  "publish",
  "subscribe",
  "psubscribe",
  "unsubscribe",
  "punsubscribe",
] as const;

type DroppedCommand = (typeof DROPPED_COMMANDS)[number];
type Command = (...args: unknown[]) => Promise<unknown>;

/**
 * A rejection nobody handles ends the process in production (index.ts), so
 * one Redis blip during a permission push or revocation would take the node
 * down. Failures are logged here instead; a lost cross-node emit is no worse
 * than one sent while the other nodes were unreachable.
 */
const catchDroppedCommands = (client: Redis, role: "pub" | "sub") => {
  const commands = client as unknown as Record<DroppedCommand, Command>;
  for (const command of DROPPED_COMMANDS) {
    const original = commands[command].bind(client);
    commands[command] = (...args) =>
      original(...args).catch((err: unknown) => {
        logger.warn({ err, command }, `WebSocket Redis ${role} command failed`);
        return undefined;
      });
  }
};

/** Sockets one user may hold on one node. */
const MAX_SOCKETS_PER_USER = 20;
const MAX_MESSAGE_BYTES = 16 * 1024;
const socketsPerUser = new Map<string, number>();

/**
 * Takes one of the user's slots for the socket, or refuses it. Counted at
 * the handshake, so handshakes in flight together cannot pass the cap. The
 * slot is freed once, at the socket's disconnect or its connection's close:
 * a client gone before the handshake finished never connects, and only the
 * connection's close says so.
 */
const claimSocketSlot = (
  socket: AuthenticatedSocket,
  next: (err?: Error) => void
) => {
  const { userId } = socket.data;
  const held = socketsPerUser.get(userId) ?? 0;
  if (held >= MAX_SOCKETS_PER_USER) {
    next(new Error("Too many connections"));
    return;
  }
  // Closed while the handshake awaited the database: no close event is left.
  if (socket.conn.readyState !== "open") {
    next(new Error("Connection closed"));
    return;
  }
  socketsPerUser.set(userId, held + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const left = (socketsPerUser.get(userId) ?? 1) - 1;
    if (left > 0) socketsPerUser.set(userId, left);
    else socketsPerUser.delete(userId);
  };
  socket.on("disconnect", release);
  socket.conn.once("close", release);
  next();
};

/** jtis per query in the periodic re-check. */
const REVALIDATE_BATCH = 500;
let revalidateTimer: NodeJS.Timeout | null = null;
let revalidating = false;

/**
 * Checks the tokens of this node's sockets again and closes those no longer
 * active. Revocations close their sockets as they happen; this catches what
 * none closes — the token of a session rotated away by a refresh, a path that
 * revokes without disconnecting, a disconnect lost while Redis was down.
 * A failed check closes nothing: a database outage must not drop every client.
 */
export const revalidateLocalSockets = async (): Promise<void> => {
  if (!io || revalidating) return;
  revalidating = true;
  try {
    const sockets = [...io.of("/").sockets.values()] as AuthenticatedSocket[];
    const jtis = [...new Set(sockets.map((s) => s.data.jti))];
    const inactive = new Set<string>();
    for (let i = 0; i < jtis.length; i += REVALIDATE_BATCH) {
      const batch = jtis.slice(i, i + REVALIDATE_BATCH);
      for (const jti of await findInactiveAccessTokens(batch)) {
        inactive.add(jti);
      }
    }
    for (const socket of sockets) {
      if (inactive.has(socket.data.jti)) socket.disconnect(true);
    }
    if (inactive.size > 0) {
      logger.debug(
        { tokens: inactive.size },
        "Closed sockets of inactive tokens"
      );
    }
  } catch (err) {
    logger.warn({ err }, "WebSocket token re-check failed");
  } finally {
    revalidating = false;
  }
};

const stopRevalidating = () => {
  if (revalidateTimer) clearInterval(revalidateTimer);
  revalidateTimer = null;
};

// setTimeout's longest delay; a token living longer is checked again then.
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Closes the socket when the token it connected with expires. The client
 * reconnects with a fresh one, which the handshake checks again.
 */
const closeAtExpiry = (socket: AuthenticatedSocket, exp: number) => {
  let timer: NodeJS.Timeout;
  const arm = () => {
    const remaining = exp * 1000 - Date.now();
    if (remaining <= 0) {
      socket.disconnect(true);
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_MS));
    timer.unref();
  };
  arm();
  socket.on("disconnect", () => clearTimeout(timer));
};

export const initializeWebSocket = async (server: HttpServer) => {
  try {
    isShuttingDown = false;
    io = new Server(server, {
      // The token comes in `auth`, not a cookie: no credentialed CORS.
      cors: { origin: env.CORS_ALLOWED_ORIGINS },
      transports: ["websocket", "polling"],
      path: "/ws",
      // Clients send only `auth:ping`.
      maxHttpBufferSize: MAX_MESSAGE_BYTES,
    });

    pubClient = createRedisClient("pub");
    subClient = createRedisClient("sub");

    io.adapter(
      // Must match the emitter's key (emitters/redisEmitter.ts).
      createAdapter(pubClient, subClient, { key: redisKey("socket.io") })
    );
    setIO(io);

    // Before authenticating, so a draining node does no database work.
    io.use((_socket, next) => {
      if (!isShuttingDown) {
        next();
        return;
      }
      next(new Error("Server is shutting down"));
    });
    io.use(authenticateSocket);
    // Last, so a refused handshake holds no slot.
    io.use((socket, next) =>
      claimSocketSlot(socket as AuthenticatedSocket, next)
    );

    io.on("connection", async (socket) => {
      const authSocket = socket as AuthenticatedSocket;
      const { userId, jti, sid, exp, orgId, clientId } = authSocket.data;
      logger.debug(`User ${userId} connected to auth WebSocket`);
      authSocket.join([
        userRoom(userId),
        ...(authSocket.data.accountEvents ? [userAccountRoom(userId)] : []),
        ...(authSocket.data.filesEvents ? [userFilesRoom(userId)] : []),
        tokenRoom(jti),
        ...(sid ? [sessionRoom(sid)] : []),
        ...(orgId ? [orgRoom(orgId), userOrgRoom(userId, orgId)] : []),
      ]);
      closeAtExpiry(authSocket, exp);
      limitMessages(authSocket);
      handlers.permission(authSocket);

      // A revocation between the handshake's check and the joins above
      // closed the rooms before this socket was in them: check once more.
      try {
        const check = await checkAccessToken(jti, clientId);
        if (!check.active) authSocket.disconnect(true);
      } catch (err) {
        logger.warn({ err, userId }, "WebSocket token re-check failed");
        authSocket.disconnect(true);
      }
    });

    stopRevalidating();
    if (env.WEBSOCKET_REVALIDATE_INTERVAL_SECONDS > 0) {
      revalidateTimer = setInterval(
        () => void revalidateLocalSockets(),
        env.WEBSOCKET_REVALIDATE_INTERVAL_SECONDS * 1000
      );
      revalidateTimer.unref();
    }

    logger.info("WebSocket server initialized on path /ws");
  } catch (error) {
    logger.error({ err: error }, "Failed to initialize WebSocket server");
    throw error;
  }
};

/**
 * Refuse new connections and close this node's clients. Runs alongside the
 * HTTP server's close, which would otherwise wait on the upgraded sockets.
 * The Redis clients stay up so emits from requests still draining work.
 */
export const disconnectWebSocketClients = async (): Promise<void> => {
  isShuttingDown = true;
  stopRevalidating();
  if (!io) return;
  // `local`: through the Redis adapter, a plain disconnect would reach every
  // other node's clients too.
  io.local.disconnectSockets(true);
  io.engine?.close();
};

export const shutdownWebSocket = async (): Promise<void> => {
  logger.debug("Shutting down auth WebSocket server...");
  await disconnectWebSocketClients();

  if (!io) {
    logger.debug("WebSocket server not initialized, skipping shutdown");
    return;
  }
  io = null;

  try {
    if (pubClient) {
      await closeRedisClient(pubClient);
      pubClient = null;
    }
    if (subClient) {
      await closeRedisClient(subClient);
      subClient = null;
    }

    logger.debug("Auth WebSocket server and Redis connections closed");
  } catch (error) {
    logger.error({ err: error }, "Error during WebSocket shutdown");
    throw error;
  }
};

export * from "./emitters/index.js";
