import type { NextFunction, Request, Response } from "express";
import env from "../env.js";
import cors from "cors";

const corsMiddleware = cors({
  origin: env.CORS_ALLOWED_ORIGINS,
  methods: ["GET", "HEAD", "POST", "PUT", "OPTIONS", "PATCH", "DELETE"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-API-Key",
    "X-Metadata",
    "X-Tags",
    "X-Organization-ID",
    "Idempotency-Key",
  ],
  credentials: true,
  maxAge: 86400,
});

const API_PREFIXES = ["/v1", "/oauth", "/.well-known", "/health"];

const isUnder = (path: string, prefix: string) =>
  path === prefix || path.startsWith(`${prefix}/`);

/**
 * Whether a response may carry the credentialed CORS headers. Not the admin
 * UI's pages, and not a GET of /oauth/authorize: both are navigated to, and a
 * listed origin fetching `prompt=none` with the browser's cookies could
 * otherwise follow the redirect and read the code from the response URL.
 */
export const sendsCors = (method: string, rawPath: string): boolean => {
  // Lowercased because Express matches routes case-insensitively.
  const path = rawPath.toLowerCase();
  if (!API_PREFIXES.some((prefix) => isUnder(path, prefix))) return false;
  return !(
    (method === "GET" || method === "HEAD") &&
    isUnder(path.replace(/\/+$/, ""), "/oauth/authorize")
  );
};

export const apiCors = (req: Request, res: Response, next: NextFunction) => {
  if (sendsCors(req.method, req.path)) corsMiddleware(req, res, next);
  else next();
};
