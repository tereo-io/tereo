import { logger } from "./logger.js";
import { v4 as uuid } from "uuid";

export interface RequestErrorMetadata {
  context?: string;
  errors?: unknown[];
  [key: string]: unknown;
}

const originalError = (
  metadata: RequestErrorMetadata | undefined
): { status?: unknown; data?: unknown } | undefined => {
  const original = metadata?.originalError;
  return original && typeof original === "object" ? original : undefined;
};

export class RequestError extends Error {
  public readonly errorId: string;
  /** The SDK's code for the call that failed, e.g. `FS_0013`. */
  public readonly code: string;
  /**
   * What an app answering with this error should send: 500 unless the
   * thrower chose otherwise. Core's own status is `httpStatus`.
   */
  public readonly statusCode: number;
  /** The HTTP status core answered with; undefined when no response came (network failure). */
  public readonly httpStatus?: number;
  /** Core's `error` code from the response body, e.g. `not_found` or `idempotency_key_conflict`. */
  public readonly coreCode?: string;
  public readonly metadata?: RequestErrorMetadata;

  constructor(
    code: string,
    message: string,
    options?: {
      statusCode?: number;
      httpStatus?: number;
      coreCode?: string;
      metadata?: RequestErrorMetadata;
      cause?: Error;
    }
  ) {
    super(message);
    this.name = "RequestError";
    this.code = code;
    this.errorId = uuid();
    this.statusCode = options?.statusCode ?? 500;
    this.metadata = options?.metadata;
    const original = originalError(options?.metadata);
    this.httpStatus =
      options?.httpStatus ??
      (typeof original?.status === "number" ? original.status : undefined);
    const body = original?.data as { error?: unknown } | undefined;
    this.coreCode =
      options?.coreCode ??
      (typeof body?.error === "string" ? body.error : undefined);
    if (options?.cause) this.cause = options.cause;
    this.logError();
  }

  private logError() {
    // A 4xx is core refusing this call, which the caller handles — a 404 is
    // often expected (`getUser` returns null). 429 is not the caller's doing.
    const refused =
      this.httpStatus !== undefined &&
      this.httpStatus >= 400 &&
      this.httpStatus < 500 &&
      this.httpStatus !== 429;
    logger[refused ? "debug" : "error"](
      {
        code: this.code,
        errorId: this.errorId,
        httpStatus: this.httpStatus,
        coreCode: this.coreCode,
        metadata: this.metadata,
      },
      `Error ${this.errorId}: Code: ${this.code}${
        this.httpStatus !== undefined
          ? ` (${this.httpStatus}${this.coreCode ? ` ${this.coreCode}` : ""})`
          : ""
      }: ${this.message}${
        this.metadata?.context ? `\n - Context: ${this.metadata.context}` : ""
      }`
    );
  }
}

/**
 * Extract the underlying HTTP status code from a `RequestError` thrown by
 * `tryHandleRequest`. Returns `undefined` when the error is not a
 * `RequestError`, when the cause was not an Axios error, or when no status
 * was attached (e.g., network-level failures).
 *
 * Useful for SDK methods that want to convert specific status codes into
 * domain-meaningful returns (e.g., 404 → null).
 */
export function getOriginalStatus(err: unknown): number | undefined {
  return err instanceof RequestError ? err.httpStatus : undefined;
}

/**
 * Extract the response body of the underlying Axios error attached to a
 * `RequestError`. Returns `undefined` when no response was captured.
 *
 * Useful for callers that need to read structured error payloads — e.g.,
 * a 410 Gone response carrying a `mergedIntoId` pointer.
 */
export function getOriginalResponseData(err: unknown): unknown {
  if (!(err instanceof RequestError)) return undefined;
  return originalError(err.metadata)?.data;
}

/**
 * Input the SDK refuses before sending, because core would refuse it or the
 * request could not carry it intact: a `..` object key, a tag with a comma.
 */
export class InvalidRequestInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestInputError";
  }
}

/**
 * Thrown by the auth middleware into the app's error handler, which answers it
 * by `statusCode` and `code` — the same shape as core's errors.
 */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = "Unauthorized") {
    super(401, "unauthorized", message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = "Forbidden") {
    super(403, "forbidden", message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not found") {
    super(404, "not_found", message);
    this.name = "NotFoundError";
  }
}
