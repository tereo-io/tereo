import { AppError, sendError } from "./errors.js";
import type { RequestHandler } from "express";
import type { Server } from "node:http";

/**
 * How long a client has to send a whole request. Node's `requestTimeout` is
 * one value for the whole server, so it is set to the upload routes' limit
 * and `requestDeadline` holds every other route to the shorter one.
 */
export const REQUEST_TIMEOUT_MS = 60_000;
export const UPLOAD_REQUEST_TIMEOUT_MS = 10 * 60_000;

// Routes whose body is a file. Express matches paths case-insensitively.
const UPLOAD_ROUTES: [method: string, path: RegExp][] = [
  ["PUT", /^\/v1\/files\/buckets\/[^/]+\/objects\/.+$/i],
  ["PUT", /^\/v1\/files\/buckets\/[^/]+\/multipart\/[^/]+\/parts\/[^/]+$/i],
  ["PUT", /^\/v1\/files\/signed\/.+$/i],
  ["POST", /^\/v1\/account\/photo\/?$/i],
];

export const isUploadRequest = (method: string, path: string): boolean =>
  UPLOAD_ROUTES.some(([m, pattern]) => m === method && pattern.test(path));

/**
 * Answers `408 request_timeout` and closes the connection when a request's
 * body has not fully arrived `timeoutMs` after its headers, unless `isExempt`
 * (the upload routes, which `server.requestTimeout` bounds instead).
 */
export function requestDeadline(
  timeoutMs: number = REQUEST_TIMEOUT_MS,
  isExempt: (method: string, path: string) => boolean = isUploadRequest
): RequestHandler {
  return (req, res, next) => {
    if (req.complete || isExempt(req.method, req.path)) return next();
    const timer = setTimeout(() => {
      if (req.complete) return;
      if (res.headersSent) {
        req.socket.destroy();
        return;
      }
      res.setHeader("Connection", "close");
      res.once("finish", () => req.socket.destroy());
      sendError(
        res,
        new AppError(408, "request_timeout", "Request not received in time")
      );
    }, timeoutMs);
    timer.unref();
    const clear = () => clearTimeout(timer);
    req.once("end", clear);
    res.once("finish", clear);
    res.once("close", clear);
    next();
  };
}

/**
 * Keep the server's idle keep-alive window LONGER than its in-cluster
 * clients'. Node defaults both sides to 5s — the global agent (keep-alive on
 * since Node 19) closes free sockets after 5s idle, and the server closes
 * idle keep-alive connections after 5s — so a client can reuse a socket in
 * the same instant the server tears it down, surfacing as a transient
 * ECONNRESET / "socket hang up" under bursts (observed webhook→audit-log on
 * `/v1/entries` in production). With the server at 65s the client always
 * closes first and never reuses a dead socket.
 */
export function tuneServerKeepAlive(server: Server): void {
  server.keepAliveTimeout = 65_000;
  // Must exceed keepAliveTimeout: headersTimeout also clocks the idle gap
  // between keep-alive requests up to the first header byte, so a value
  // below keepAliveTimeout would reintroduce the same close-vs-reuse race.
  server.headersTimeout = 66_000;
}

/**
 * Stop accepting connections and wait for in-flight requests, forcing the
 * rest closed after `drainMs`. `closeUpgraded` must close upgraded
 * (WebSocket) connections: `server.close()` waits on them, and
 * `closeAllConnections()` cannot reach them.
 */
export async function closeHttpServer(
  server: Server,
  closeUpgraded: () => Promise<void>,
  drainMs: number
): Promise<void> {
  // Never listened (a failed listen): close() would reject with
  // ERR_SERVER_NOT_RUNNING, and there is nothing to drain.
  if (!server.listening) {
    await closeUpgraded();
    return;
  }
  const closed = new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  const drainTimer = setTimeout(() => {
    server.closeIdleConnections();
    server.closeAllConnections();
  }, drainMs);
  try {
    await Promise.all([closeUpgraded(), closed]);
  } finally {
    clearTimeout(drainTimer);
  }
}
