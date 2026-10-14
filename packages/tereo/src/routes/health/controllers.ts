import { probeDependencies } from "../../utils/health.js";
import { CORE_VERSION } from "../../utils/version.js";
import type { Request, Response } from "express";
import env from "../../env.js";

/** Liveness and readiness: 503 `degraded` when Postgres or Redis is down. */
export const getHealth = async (_req: Request, res: Response) => {
  const { dbOk, redisOk } = await probeDependencies();
  const healthy = dbOk && redisOk;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    service: env.SERVICE_NAME,
    version: CORE_VERSION,
    timestamp: new Date().toISOString(),
    ...(dbOk ? {} : { db: "fail" }),
    ...(redisOk ? {} : { redis: "fail" }),
  });
};
