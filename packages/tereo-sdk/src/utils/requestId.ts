import type { Request, RequestHandler, Response, NextFunction } from "express";
import { AsyncLocalStorage } from "async_hooks";
import crypto from "crypto";

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

const store = new AsyncLocalStorage<{ requestId: string }>();

/** The current request's id, or undefined outside `requestIdMiddleware`. */
export function getRequestId(): string | undefined {
  return store.getStore()?.requestId;
}

/**
 * Gives each request an id — the incoming `x-request-id`, or a new one —
 * echoes it as `X-Request-ID`, and forwards it on every call to core made
 * while handling the request.
 */
export function requestIdMiddleware(
  headerName = "x-request-id"
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const existing = req.headers[headerName];
    const requestId =
      (typeof existing === "string" && existing) ||
      crypto.randomBytes(16).toString("hex");
    req.requestId = requestId;
    res.setHeader("X-Request-ID", requestId);
    store.run({ requestId }, next);
  };
}
