import { Request, Response, NextFunction } from "express";
import { redactUrl } from "../telemetry/redact.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import db from "../utils/db/index.js";

interface AccessLogContext {
  bucketId?: number;
  objectId?: string;
  operation: string;
}

// Extend Express Response to include access log context
declare global {
  namespace Express {
    interface Response {
      accessLog?: AccessLogContext;
    }
  }
}

/**
 * The error stored on an access-log row. A Prisma client error's message can
 * reprint the query with its values, so only its class and code are kept.
 */
export const accessLogErrorMessage = (err: unknown): string | undefined => {
  if (err instanceof Error && err.name.startsWith("PrismaClient")) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? `${err.name} ${code}` : err.name;
  }
  if (err instanceof Error) return err.message.slice(0, 1000);
  return err != null ? String(err).slice(0, 1000) : undefined;
};

/**
 * Access logging middleware
 * Logs all API operations to the database for audit trail
 */
export const accessLogMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const startTime = Date.now();
  let logged = false;

  // Capture the original res.send/json to log after response
  const originalSend = res.send;
  const originalJson = res.json;

  const logRequest = async () => {
    if (logged) return;
    logged = true;

    const duration = Date.now() - startTime;
    const accessLog = res.accessLog;
    if (!accessLog) return;

    // `req.ip` honors the configured `trust proxy` setting, falling back to
    // `socket.remoteAddress`. Direct X-Forwarded-For parsing here would
    // bypass that and let any client spoof the logged IP.
    const ipAddress = req.ip || req.socket.remoteAddress || "unknown";

    const userAgent = req.headers["user-agent"];

    const fallbackError = (
      res as Response & { accessLogFallbackError?: unknown }
    ).accessLogFallbackError;
    const errorMessage = accessLogErrorMessage(fallbackError);

    try {
      await db.accessLogs.create({
        bucketId: accessLog.bucketId,
        objectId: accessLog.objectId,
        userId: req.auth?.userId,
        operation: accessLog.operation,
        statusCode: res.statusCode,
        ipAddress,
        userAgent,
        requestId: req.requestId,
        errorMessage,
      });

      logger.debug(
        {
          requestId: req.requestId,
          operation: accessLog.operation,
          statusCode: res.statusCode,
          userId: req.auth?.userId,
          duration,
        },
        "Access logged"
      );
    } catch (error) {
      logger.error(
        {
          requestId: req.requestId,
          err: error,
        },
        "Failed to log access"
      );
    }
  };

  res.send = function (data) {
    logRequest();
    return originalSend.call(this, data);
  };

  res.json = function (data) {
    logRequest();
    return originalJson.call(this, data);
  };

  // Handle cases where response ends without send/json (streaming, etc.)
  res.on("finish", () => {
    if (res.accessLog && !logged) logRequest();
  });
  // A response cut off mid-body (a failed blob stream, a client gone) never
  // finishes.
  res.on("close", () => {
    if (!res.accessLog || logged) return;
    if (!res.writableFinished) {
      noteAccessLogError(res, new Error("Response closed before completion"));
    }
    logRequest();
  });

  next();
};

/** Records why a response failed on its access-log row; the first wins. */
export const noteAccessLogError = (res: Response, err: unknown): void => {
  const target = res as Response & { accessLogFallbackError?: unknown };
  target.accessLogFallbackError ??= err;
};

/**
 * Helper to set access log context on response
 */
export const setAccessLog = (
  res: Response,
  context: AccessLogContext
): void => {
  res.accessLog = context;
};

/**
 * Marks the request so `accessLogErrorFallback` writes no row for a 401 or
 * 429 that reached it with no access log set: a rejection an unauthenticated
 * caller can produce at will.
 */
export const skipRejectedAccessLogs = (
  _req: Request,
  res: Response,
  next: NextFunction
) => {
  res.locals.skipRejectedAccessLogs = true;
  next();
};

/**
 * Express error middleware that synthesizes an access-log entry for requests
 * that errored BEFORE a controller had a chance to call `setAccessLog`
 * (validation errors, 401, 404, 412, etc.). Keeps the primary-path semantics
 * untouched — if a controller already set `res.accessLog`, we reuse it.
 *
 * Mount this BEFORE `errorHandler` (`utils/errors.ts`)
 * so it fires on every rejected request regardless of the final JSON body.
 */
export const accessLogErrorFallback = (
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const status = err instanceof AppError ? err.statusCode : undefined;
  if (
    !res.accessLog &&
    res.locals.skipRejectedAccessLogs === true &&
    (status === 401 || status === 429)
  ) {
    return next(err);
  }
  if (!res.accessLog) {
    // Synthesize a minimal record so the main log handler still writes a row
    // on error paths. Without a resolved bucket we leave `bucketId` off —
    // the column is nullable on the `AccessLog` table and we prefer a row
    // without the relation over silently dropping the audit event. Truncate
    // to the `operation` column's VARCHAR(50) cap — object-key paths easily
    // exceed that, and a truncated operation beats a failed insert. A share
    // link's token is replaced, as in every log.
    const operation = `${req.method} ${redactUrl(req.path)}`.slice(0, 50);
    setAccessLog(res, { operation });
    (
      res as Response & { accessLogFallbackError?: unknown }
    ).accessLogFallbackError = err;
  }
  next(err);
};
