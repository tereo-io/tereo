import { Request, RequestHandler, Response, NextFunction } from "express";
import { AsyncLocalStorage } from "async_hooks";
import crypto from "crypto";

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

export interface RequestIdConfig {
  /** Request header to read an existing ID from (default: "x-request-id") */
  headerName?: string;
}

interface RequestContext {
  requestId: string;
  ipAddress: string;
  path: string;
}

const requestContextStore = new AsyncLocalStorage<RequestContext>();

/**
 * Retrieve the current request ID from async context.
 * Returns undefined if called outside a request lifecycle.
 */
export function getRequestId(): string | undefined {
  return requestContextStore.getStore()?.requestId;
}

/**
 * Retrieve the current client IP address from async context.
 * Returns undefined if called outside a request lifecycle.
 */
export function getRequestIpAddress(): string | undefined {
  return requestContextStore.getStore()?.ipAddress;
}

/**
 * The current request's path, without the query string or a trailing slash.
 * Undefined outside a request lifecycle.
 */
export function getRequestPath(): string | undefined {
  return requestContextStore.getStore()?.path;
}

/** `/a/b/?x=1` → `/a/b`. */
export const requestPath = (originalUrl: string): string =>
  originalUrl.split("?")[0].replace(/(.)\/+$/, "$1");

/**
 * The client's IP. `req.ip` honors Express's `trust proxy` setting, so a
 * client cannot spoof it with its own `X-Forwarded-For` unless that proxy
 * is trusted. IPv6-mapped IPv4 ("::ffff:172.18.0.1") is unwrapped.
 */
export function clientIp(req: Request): string {
  const raw = req.ip || req.socket?.remoteAddress;
  if (!raw) return "unknown";
  return raw.startsWith("::ffff:") ? raw.slice(7) : raw;
}

/**
 * Middleware that assigns a unique request ID to each request.
 * Reads from the incoming header if present, otherwise generates one.
 * Sets the ID on `req.requestId`, echoes it via the response header,
 * and propagates it along with the client IP address through
 * AsyncLocalStorage for automatic access in downstream code
 * (e.g., audit logging) without explicit passing.
 */
/**
 * A client's own X-Request-ID is kept only in this shape: it is stored in
 * columns as narrow as VarChar(64) (`access_logs.request_id`) and echoed in
 * logs and the response header. Anything else gets a generated id.
 */
const CLIENT_REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export function createRequestIdMiddleware(
  config?: RequestIdConfig
): RequestHandler {
  const headerName = config?.headerName ?? "x-request-id";

  return (req: Request, res: Response, next: NextFunction) => {
    const existing = req.headers[headerName];
    const requestId =
      typeof existing === "string" && CLIENT_REQUEST_ID.test(existing)
        ? existing
        : crypto.randomBytes(16).toString("hex");

    req.requestId = requestId;
    res.setHeader("X-Request-ID", requestId);

    const ipAddress = clientIp(req);

    requestContextStore.run(
      { requestId, ipAddress, path: requestPath(req.originalUrl ?? req.url) },
      next
    );
  };
}
