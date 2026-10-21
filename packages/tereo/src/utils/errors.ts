import { Response, Request, NextFunction } from "express";
import { redactUrl } from "../telemetry/redact.js";
import { logger } from "./logger.js";
import { ZodError } from "zod";
import {
  isForeignKeyConstraintError,
  isUniqueConstraintError,
} from "./prismaErrors.js";

export interface AppErrorOptions {
  /** Extra response body fields, after `error` and `error_description`. */
  details?: Record<string, unknown>;
  /** Response headers, e.g. `Retry-After`. */
  headers?: Record<string, string | number>;
}

export class AppError extends Error {
  public details?: Record<string, unknown>;
  public headers?: Record<string, string | number>;

  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    options: AppErrorOptions = {}
  ) {
    super(message);
    this.name = "AppError";
    this.details = options.details;
    this.headers = options.headers;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, "invalid_request", message);
    this.name = "ValidationError";
  }
}

export class BadRequestError extends AppError {
  constructor(code: string, message: string) {
    super(400, code, message);
    this.name = "BadRequestError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(
    message = "Unauthorized",
    code = "unauthorized",
    options: AppErrorOptions = {}
  ) {
    super(401, code, message, options);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, "forbidden", message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, "not_found", message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = "conflict") {
    super(409, code, message);
    this.name = "ConflictError";
  }
}

export class ManagedByProvisioningError extends AppError {
  constructor(
    message = "Managed by the provisioning file; change it there and restart core"
  ) {
    super(409, "managed_by_provisioning", message);
    this.name = "ManagedByProvisioningError";
  }
}

/** A webhook endpoint an integration manages: only it changes it, beyond a pause or removal. */
export class ManagedByIntegrationError extends AppError {
  constructor(
    message = "Managed by the integration that owns it; an admin may only pause, archive or delete it"
  ) {
    super(409, "managed_by_integration", message);
    this.name = "ManagedByIntegrationError";
  }
}

/** Integrations never hold a role carrying the root `admin` permission. */
export class RoleNotAllowedForIntegrationError extends AppError {
  constructor(message: string) {
    super(403, "role_not_allowed_for_integration", message);
    this.name = "RoleNotAllowedForIntegrationError";
  }
}

/**
 * A request with the same idempotency key is still running: one code for
 * uploads, emits and audit writes. Retry shortly.
 */
export class IdempotencyInProgressError extends AppError {
  constructor(
    message = "A request with this idempotency key is already being processed"
  ) {
    super(409, "idempotency_request_in_progress", message);
    this.name = "IdempotencyInProgressError";
  }
}

/**
 * Mutation rejected because the target row is archived. A 409 like
 * ConflictError, but its own `resource_archived` code so clients can
 * distinguish "restore it first" from other state conflicts. Paired with the
 * `guardArchived` middleware.
 */
export class ArchivedError extends AppError {
  constructor(message = "Resource is archived; restore it before modifying") {
    super(409, "resource_archived", message);
    this.name = "ArchivedError";
  }
}

/** Archive of a row that is already archived. */
export class AlreadyArchivedError extends AppError {
  constructor(message = "Resource is already archived") {
    super(409, "already_archived", message);
    this.name = "AlreadyArchivedError";
  }
}

/** Restore of a row that is not archived. */
export class NotArchivedError extends AppError {
  constructor(message = "Resource is not archived") {
    super(409, "not_archived", message);
    this.name = "NotArchivedError";
  }
}

/**
 * Every rate-limit refusal: `too_many_requests`, with the seconds to wait in
 * both the `Retry-After` header and the body's `retry_after`.
 */
export class TooManyRequestsError extends AppError {
  constructor(
    public retryAfter: number,
    message = "Rate limit exceeded. Please try again later."
  ) {
    super(429, "too_many_requests", message, {
      details: { retry_after: retryAfter },
      headers: { "Retry-After": retryAfter },
    });
    this.name = "TooManyRequestsError";
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message: string, retryAfter?: number) {
    super(503, "temporarily_unavailable", message, {
      headers:
        retryAfter === undefined ? undefined : { "Retry-After": retryAfter },
    });
    this.name = "ServiceUnavailableError";
  }
}

/**
 * A 500 thrown on purpose, for state that should be impossible: the client
 * gets the generic message, and whatever names the rows goes in the log.
 */
export class InternalServerError extends AppError {
  constructor(message = "An unexpected error occurred") {
    super(500, "server_error", message);
    this.name = "InternalServerError";
  }
}

/** An upstream service core depends on failed or could not be reached. */
export class BadGatewayError extends AppError {
  constructor(code: string, message: string) {
    super(502, code, message);
    this.name = "BadGatewayError";
  }
}

export class PreconditionFailedError extends AppError {
  constructor(message: string, code = "precondition_failed") {
    super(412, code, message);
    this.name = "PreconditionFailedError";
  }
}

export class UnprocessableEntityError extends AppError {
  constructor(code: string, message: string) {
    super(422, code, message);
    this.name = "UnprocessableEntityError";
  }
}

/**
 * RFC 6749 / OpenID Connect error. Same wire format as AppError
 * (`{ error, error_description }`) — distinct class for semantic clarity at
 * OAuth2/OIDC call sites so the throw/catch pattern is uniform repo-wide.
 */
export class OAuth2Error extends AppError {
  constructor(error: string, description: string, statusCode = 400) {
    super(statusCode, error, description);
    this.name = "OAuth2Error";
  }
}

/**
 * The token endpoint's `invalid_grant`: a code or refresh token that is
 * unknown, spent, expired, revoked or not this client's. Deliberately one
 * description for every cause, so a caller cannot tell them apart.
 */
export class InvalidGrantError extends OAuth2Error {
  constructor() {
    super(
      "invalid_grant",
      "The provided authorization grant is invalid, expired, or revoked"
    );
    this.name = "InvalidGrantError";
  }
}

/**
 * An AppError, or anything shaped like one — a library error carrying an HTTP
 * status. Prisma errors have a string `code` but no `statusCode`, so they fall
 * through to their own branch below.
 */
const isAppErrorLike = (
  err: unknown
): err is Error & { statusCode: number; code: string } => {
  if (err instanceof AppError) return true;
  const { statusCode, code } = (err ?? {}) as {
    statusCode?: unknown;
    code?: unknown;
  };
  return (
    Number.isInteger(statusCode) &&
    (statusCode as number) >= 400 &&
    (statusCode as number) <= 599 &&
    typeof code === "string"
  );
};

/**
 * A body-parser (`express.json` / `express.urlencoded`) rejection: an
 * http-errors 4xx with a string `type` such as `entity.parse.failed` or
 * `entity.too.large`, but no `code`.
 */
const bodyParserError = (
  err: unknown
): { status: number; code: string; message: string } | null => {
  const { status, type, expose } = (err ?? {}) as {
    status?: unknown;
    type?: unknown;
    expose?: unknown;
  };
  if (
    typeof type !== "string" ||
    !Number.isInteger(status) ||
    (status as number) < 400 ||
    (status as number) > 499
  ) {
    return null;
  }
  if (type === "entity.parse.failed") {
    return {
      status: 400,
      code: "invalid_request",
      message: "Request body is malformed",
    };
  }
  if (type === "entity.too.large") {
    return {
      status: 413,
      code: "payload_too_large",
      message: "Request body is too large",
    };
  }
  return {
    status: status as number,
    code: "invalid_request",
    message:
      expose === true && err instanceof Error
        ? err.message
        : "Request body could not be read",
  };
};

interface ErrorResponse {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  headers?: Record<string, string | number>;
}

const errorResponse = (err: Error): ErrorResponse => {
  const bodyError = bodyParserError(err);
  if (bodyError) return bodyError;

  if (err instanceof ZodError) {
    // RFC 6749 Section 5.2: invalid_request for malformed requests
    return {
      status: 400,
      code: "invalid_request",
      message: err.issues
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(", "),
    };
  }

  if (err instanceof AppError) {
    return {
      status: err.statusCode,
      code: err.code,
      message: err.message,
      details: err.details,
      headers: err.headers,
    };
  }

  if (isAppErrorLike(err)) {
    return { status: err.statusCode, code: err.code, message: err.message };
  }

  // A write conflict or deadlock (P2034): retryable, so 409 lets clients
  // back off and retry.
  const prismaCode = (err as { code?: unknown }).code;
  if (prismaCode === "P2034") {
    return {
      status: 409,
      code: "version_conflict",
      message:
        "Concurrent update conflict; retry the request after re-reading state",
    };
  }

  // An update or delete whose row was not there (P2025) that no caller
  // mapped: the row is gone, typically deleted since the request read it.
  if (prismaCode === "P2025") {
    return { status: 404, code: "not_found", message: "Not found" };
  }

  // A unique violation that no caller mapped to a specific error — typically
  // two concurrent creates of the same name. Besides P2002 it arrives wrapped
  // in other codes or as the raw driver adapter error (see prismaErrors.ts).
  if (isUniqueConstraintError(err)) {
    return {
      status: 409,
      code: "conflict",
      message: "A resource with the same unique value already exists",
    };
  }

  // A foreign-key or RESTRICT violation no caller mapped: the row is still
  // referenced, or a row it references went away since the request read it.
  if (isForeignKeyConstraintError(err)) {
    return {
      status: 409,
      code: "conflict",
      message:
        "The change conflicts with a record this one references or is referenced by",
    };
  }

  return {
    status: 500,
    code: "server_error",
    message: "An unexpected error occurred",
  };
};

// Set by a download before its body fails; on the error they would describe
// the JSON body as the file (a 416 passes its own `Content-Range`).
const REPRESENTATION_HEADERS = [
  "Content-Disposition",
  "Content-Range",
  "ETag",
  "Last-Modified",
];

const writeError = (
  res: Response,
  { status, code, message, details, headers }: ErrorResponse
): void => {
  if (res.headersSent) {
    // The status line is out: only a reset tells the client the body is cut.
    res.destroy();
    return;
  }
  for (const name of REPRESENTATION_HEADERS) res.removeHeader(name);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(headers ?? {})) {
    res.setHeader(name, value);
  }
  res
    .status(status)
    .json({ error: code, error_description: message, ...details });
};

/**
 * Write an error response where an error cannot be thrown to the handler,
 * e.g. from a stream's `error` event once the controller has returned.
 */
export const sendError = (res: Response, err: AppError): void => {
  writeError(res, errorResponse(err));
};

/**
 * A Prisma validation error's message reprints the whole query, argument
 * values included. For logs it is cut to its first line, which names the
 * call, and the stack keeps its frames without the message.
 */
export const loggableError = (err: Error): Error => {
  if (err.name !== "PrismaClientValidationError") return err;
  const summary =
    err.message
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const loggable = new Error(summary);
  loggable.name = err.name;
  const frames = (err.stack ?? "")
    .split("\n")
    .filter((line) => /^\s+at /.test(line));
  loggable.stack = [`${err.name}: ${summary}`, ...frames].join("\n");
  return loggable;
};

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const response = errorResponse(err);
  const { status, code } = response;

  // The query string and a share link's token are left out.
  const context = {
    method: req.method,
    path: req.originalUrl && redactUrl(req.originalUrl),
    status,
  };
  const logged = loggableError(err);
  if (status >= 500) {
    logger.error({ ...context, err: logged }, logged.message);
  } else {
    logger.warn({ ...context, code, name: err.name }, logged.message);
  }

  writeError(res, response);
};

/**
 * RFC 6750 Section 3.1: invalid_token
 * The access token provided is expired, revoked, malformed, or invalid for other reasons.
 */
export class InvalidTokenError extends AppError {
  constructor(message = "Invalid or expired access token") {
    super(401, "invalid_token", message);
    this.name = "InvalidTokenError";
  }
}

export class InsufficientStorageError extends AppError {
  constructor(message: string) {
    super(507, "insufficient_storage", message);
    this.name = "InsufficientStorageError";
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message: string) {
    super(413, "payload_too_large", message);
    this.name = "PayloadTooLargeError";
  }
}
