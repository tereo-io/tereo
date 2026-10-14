import type { NextFunction, Request, Response } from "express";
import { requestPath } from "../utils/requestId.js";
import { authLog } from "../utils/audit.js";

/**
 * Writes an auth log line for every /oauth and /v1/admin request once it
 * finishes. The path is taken on the way in: by `finish`, the nested routers
 * have stripped their mount prefixes from `req.path`.
 */
export const authRequestLog = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const path = requestPath(req.originalUrl);
  if (!path.startsWith("/oauth") && !path.startsWith("/v1/admin")) {
    return next();
  }
  const startTime = Date.now();
  res.on("finish", () => {
    authLog({
      event: "http_request",
      method: req.method,
      path,
      statusCode: res.statusCode,
      duration: Date.now() - startTime,
      ip: req.ip || req.socket.remoteAddress,
      userAgent: req.headers["user-agent"],
    });
  });
  next();
};
