import "./preload.js";
import { ensureBlobDirectory, ensureTempDirectory } from "./utils/storage.js";
import { closeHttpServer, tuneServerKeepAlive } from "./utils/httpServer.js";
import { ProvisioningError, provision } from "./utils/provisioning/index.js";
import { closeRedisEmitter } from "./websocket/emitters/redisEmitter.js";
import { closeRedisConnection, initializeRedis } from "./utils/redis.js";
import { prepareAndRegisterCore } from "./utils/coreRegistration.js";
import { loadKeys, startSigningKeyRefresh } from "./utils/keys.js";
import { resealRowSecrets } from "./utils/resealRowSecrets.js";
import { sealWebhookSecrets } from "./utils/webhookSecrets.js";
import { startWorkerHealthServer } from "./utils/health.js";
import { ensureLoginClient } from "./utils/loginClient.js";
import { announceSetupIfPending } from "./utils/setup.js";
import { disconnectDatabase } from "./utils/db/prisma.js";
import { startWorker, stopWorker } from "./worker.js";
import { shutdownOtel } from "./telemetry/index.js";
import env, { stalePathWarnings } from "./env.js";
import { createServer, Server } from "http";
import { logger } from "./utils/logger.js";
import {
  closeCacheBroadcast,
  startCacheSubscriber,
} from "./utils/cacheBroadcast.js";
import {
  disconnectWebSocketClients,
  initializeWebSocket,
  shutdownWebSocket,
} from "./websocket/index.js";

// k8s terminationGracePeriod is typically 30s; give ourselves a 25s drain
// window for in-flight HTTP requests before we forcibly close idle and then
// all remaining connections.
const DRAIN_TIMEOUT_MS = 25_000;

const runsApi = env.ROLE === "all" || env.ROLE === "api";
const runsWorker = env.ROLE === "all" || env.ROLE === "worker";

export interface ServerInstance {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isRunning: () => boolean;
}

export function createAppServer(port: number = env.PORT): ServerInstance {
  let server: Server | null = null;
  let healthServer: Server | null = null;
  let running = false;
  let stopping: Promise<void> | null = null;
  let stopKeyRefresh: (() => void) | null = null;

  return {
    start: async () => {
      if (running) throw new Error("Server is already running");
      running = true;
      const stale = stalePathWarnings({
        ...env,
        PROVISIONING_FILE: process.env.PROVISIONING_FILE,
      });
      for (const warning of stale) logger.warn(warning);

      // Before anything signs, verifies or decrypts.
      await loadKeys();
      // Signing still opens a plaintext secret, so a failure here only delays
      // sealing to the next start or the endpoint's next delivery.
      await sealWebhookSecrets().catch((err) => {
        logger.error({ err }, "Sealing webhook signing secrets failed");
      });
      // Picks up a signing key rotated by another process.
      stopKeyRefresh = startSigningKeyRefresh();
      await ensureTempDirectory();
      await ensureBlobDirectory();
      await initializeRedis(env);
      await startCacheSubscriber();
      await prepareAndRegisterCore();
      // The UI's redirect URI follows UI_BASE_URL.
      await ensureLoginClient();
      // Services and login clients the deploy declares; a file that cannot
      // be applied stops the start.
      await provision().catch((err) => {
        if (err instanceof ProvisioningError)
          for (const problem of err.problems)
            logger.error({ problem }, "Provisioning refused");
        throw err;
      });
      // Moves secrets in table columns off a previous KEK, as loadKeys() did
      // for core.secrets, so none is left under it unused.
      const resealed = await resealRowSecrets();
      if (resealed.failed > 0) {
        logger.error(resealed, "Some sealed row secrets could not be opened");
      }

      if (runsWorker) await startWorker();
      if (!runsApi) {
        healthServer = await startWorkerHealthServer(env.WORKER_HEALTH_PORT);
        logger.info(
          { role: env.ROLE, healthPort: env.WORKER_HEALTH_PORT },
          "Worker started"
        );
        return;
      }

      // Only processes that serve /setup print a token for it.
      await announceSetupIfPending();

      // Imported after Redis is up: rate limiters resolve the Redis client
      // when their modules load.
      const { default: app } = await import("./app.js");
      // Uploads carry large headers (metadata, tags) and long bodies: raise
      // the header cap, and bound total request time so a stuck upload can't
      // hold a socket forever. Large files go through multipart instead.
      server = createServer({ maxHeaderSize: 200 * 1024 }, app);
      server.requestTimeout = 10 * 60 * 1000;
      tuneServerKeepAlive(server);
      await initializeWebSocket(server);

      const listening = server;
      await new Promise<void>((resolve, reject) => {
        listening.once("error", reject);
        listening.listen(port, () => {
          listening.off("error", reject);
          logger.info({ port, role: env.ROLE }, "tereo listening");
          resolve();
        });
      });
    },

    stop: () => {
      if (!running) return Promise.resolve();
      // A second signal mid-shutdown waits on the first instead of closing
      // everything twice.
      stopping ??= (async () => {
        // Every step runs even if an earlier one fails, so a failed start
        // or a broken step still releases Redis and the database.
        const failures: unknown[] = [];
        const step = async (name: string, run: () => Promise<void>) => {
          try {
            await run();
          } catch (err) {
            failures.push(err);
            logger.error({ err, step: name }, "Shutdown step failed");
          }
        };

        // Drain HTTP before tearing anything down — handlers would otherwise
        // throw "pool ended" / "client closed" mid-flight. WebSocket clients
        // are disconnected alongside, or the close would wait on them.
        if (server) {
          const closing = server;
          server = null;
          await step("http", async () => {
            await closeHttpServer(
              closing,
              disconnectWebSocketClients,
              DRAIN_TIMEOUT_MS
            );
            logger.info("HTTP server closed");
          });
          await step("websocket", shutdownWebSocket);
        }

        stopKeyRefresh?.();
        stopKeyRefresh = null;
        if (healthServer) {
          const closing = healthServer;
          healthServer = null;
          await step("health", async () => {
            const closed = new Promise<void>((resolve) =>
              closing.close(() => resolve())
            );
            // Probe connections are kept alive; close() would wait on them.
            closing.closeAllConnections();
            await closed;
          });
        }
        if (runsWorker) await step("worker", stopWorker);
        await step("cacheBroadcast", closeCacheBroadcast);
        await step("redisEmitter", closeRedisEmitter);
        await step("redis", closeRedisConnection);
        await step("database", disconnectDatabase);
        running = false;
        logger.info("Server closed");
        await step("telemetry", shutdownOtel);
        if (failures.length > 0) {
          throw new AggregateError(failures, "Shutdown did not complete");
        }
      })().finally(() => {
        stopping = null;
      });
      return stopping;
    },

    isRunning: () => running,
  };
}

// Started directly (`node dist/index.js`), not imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const appServer = createAppServer();

  appServer.start().catch((err) => {
    logger.error({ err }, "Failed to start server");
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      logger.info("Shutdown already in progress");
      return;
    }
    shuttingDown = true;
    logger.info("Shutting down server...");
    try {
      await appServer.stop();
    } catch {
      process.exit(1);
    }
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  process.on("uncaughtException", (err) => {
    logger.error({ err }, "uncaughtException");
    // In production, let the orchestrator restart us — a process kept alive
    // after an uncaught exception often carries subtly corrupted state.
    if (env.NODE_ENV === "production") process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "unhandledRejection");
    if (env.NODE_ENV === "production") process.exit(1);
  });
}
