import { probeDependenciesCached } from "../../utils/health.js";
import type { Request, Response } from "express";
import env from "../../env.js";

/**
 * Liveness and readiness: 503 `degraded` when Postgres or Redis is down.
 * Public, so it names no version; an admin finds core's on its service row.
 */
export const getHealth = async (_req: Request, res: Response) => {
  const { dbOk, redisOk } = await probeDependenciesCached();
  const healthy = dbOk && redisOk;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    service: env.SERVICE_NAME,
    timestamp: new Date().toISOString(),
    ...(dbOk ? {} : { db: "fail" }),
    ...(redisOk ? {} : { redis: "fail" }),
  });
};
