import { createServer, type Server, type ServerResponse } from "node:http";
import { healthCheck as dbHealthCheck } from "./db/prisma.js";
import { workerStatus } from "../jobs/workerRegistry.js";
import { getRedisClient } from "./redis.js";
import { CORE_VERSION } from "./version.js";
import { logger } from "./logger.js";
import env from "../env.js";

const HEALTH_PROBE_TIMEOUT_MS = 500;

let draining = false;

/** Set as shutdown starts, so readiness drops before the drain ends. */
export const setDraining = (value: boolean) => {
  draining = value;
};

export interface ReadinessReport {
  status: "ok" | "draining";
  service: string;
  timestamp: string;
}

// Deliberately not the dependency probe: a Postgres slow under load would
// take every replica out of rotation at once, turning slow into down.
export const readiness = (): ReadinessReport => ({
  status: draining ? "draining" : "ok",
  service: env.SERVICE_NAME,
  timestamp: new Date().toISOString(),
});

const withTimeout = <T>(p: Promise<T>): Promise<T | "timeout"> => {
  let handle: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    handle = setTimeout(() => resolve("timeout"), HEALTH_PROBE_TIMEOUT_MS);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (handle) clearTimeout(handle);
  });
};

export interface DependencyHealth {
  dbOk: boolean;
  redisOk: boolean;
}

/** Pings Postgres and Redis, each bounded so a hung one fails fast. */
export async function probeDependencies(): Promise<DependencyHealth> {
  let dbOk: boolean;
  let redisOk: boolean;
  try {
    dbOk = (await withTimeout(dbHealthCheck())) !== "timeout";
  } catch {
    dbOk = false;
  }
  try {
    redisOk = (await withTimeout(getRedisClient().ping())) === "PONG";
  } catch {
    redisOk = false;
  }
  return { dbOk, redisOk };
}

const PROBE_CACHE_MS = 1_000;
let lastProbe: { startedAt: number; result: Promise<DependencyHealth> } | null =
  null;

/**
 * `probeDependencies`, its result shared for a second after the probe starts,
 * so a burst of /health requests pings Postgres and Redis once.
 */
export function probeDependenciesCached(): Promise<DependencyHealth> {
  const now = Date.now();
  if (!lastProbe || now - lastProbe.startedAt >= PROBE_CACHE_MS) {
    lastProbe = { startedAt: now, result: probeDependencies() };
  }
  return lastProbe.result;
}

export interface WorkerHealthReport {
  status: "ok" | "degraded";
  service: string;
  role: "worker";
  version: string;
  timestamp: string;
  db?: "fail";
  redis?: "fail";
  workers: { total: number; stopped?: string[] };
}

/**
 * Health of a ROLE=worker process: its dependencies, and its BullMQ workers —
 * at least one, none of them closing or stopped.
 */
async function workerHealth(): Promise<WorkerHealthReport> {
  const { dbOk, redisOk } = await probeDependencies();
  const { total, stopped } = workerStatus();
  const workersOk = total > 0 && stopped.length === 0;
  return {
    status: dbOk && redisOk && workersOk ? "ok" : "degraded",
    service: env.SERVICE_NAME,
    role: "worker",
    version: CORE_VERSION,
    timestamp: new Date().toISOString(),
    ...(dbOk ? {} : { db: "fail" as const }),
    ...(redisOk ? {} : { redis: "fail" as const }),
    workers: { total, ...(stopped.length ? { stopped } : {}) },
  };
}

const sendJson = (res: ServerResponse, ok: boolean, body: object) => {
  res
    .writeHead(ok ? 200 : 503, { "Content-Type": "application/json" })
    .end(JSON.stringify(body));
};

/**
 * A worker process serves no API, so it answers `GET /health` and
 * `/health/ready` on its own port for the container and orchestrator probes
 * (HEAD too: the image's `wget --spider` sends one). Anything else is a 404.
 */
export async function startWorkerHealthServer(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const probe = req.method === "GET" || req.method === "HEAD";
    const path = req.url?.split("?")[0];
    if (!probe || (path !== "/health" && path !== "/health/ready")) {
      res.writeHead(404).end();
      return;
    }
    if (path === "/health/ready") {
      const report = readiness();
      sendJson(res, report.status === "ok", report);
      return;
    }
    workerHealth().then(
      (report) => sendJson(res, report.status === "ok", report),
      (err: unknown) => {
        logger.error({ err }, "Worker health check failed");
        res.writeHead(503).end();
      }
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
