import { closeRedisClient, createRedis, redisKey } from "../utils/redis.js";
import { redisRetryStrategy } from "../utils/redisRetry.js";
import { authenticateSocket } from "./middleware/auth.js";
import { createAdapter } from "@socket.io/redis-adapter";
import { setIO } from "./emitters/permissionEmitters.js";
import { checkAccessToken } from "../utils/sessions.js";
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
  userOrgRoom,
  userRoom,
} from "./emitters/sessionEmitters.js";
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
      cors: {
        origin: env.CORS_ALLOWED_ORIGINS,
        credentials: true,
      },
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
    io.use((socket, next) => {
      const userId = (socket as AuthenticatedSocket).data.userId;
      if ((socketsPerUser.get(userId) ?? 0) >= MAX_SOCKETS_PER_USER) {
        next(new Error("Too many connections"));
        return;
      }
      next();
    });

    io.on("connection", async (socket) => {
      const authSocket = socket as AuthenticatedSocket;
      const { userId, jti, sid, exp, orgId, clientId } = authSocket.data;
      socketsPerUser.set(userId, (socketsPerUser.get(userId) ?? 0) + 1);
      authSocket.on("disconnect", () => {
        const left = (socketsPerUser.get(userId) ?? 1) - 1;
        if (left > 0) socketsPerUser.set(userId, left);
        else socketsPerUser.delete(userId);
      });
      logger.debug(`User ${userId} connected to auth WebSocket`);
      authSocket.join([
        userRoom(userId),
        tokenRoom(jti),
        ...(sid ? [sessionRoom(sid)] : []),
        ...(orgId ? [orgRoom(orgId), userOrgRoom(userId, orgId)] : []),
      ]);
      closeAtExpiry(authSocket, exp);
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
