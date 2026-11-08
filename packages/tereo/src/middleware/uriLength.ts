import { sendError, UriTooLongError } from "../utils/errors.js";
import type { NextFunction, Request, Response } from "express";
import { logger } from "../utils/logger.js";

// Bytes of the request target as sent, percent-encoding included. The longest
// path a route accepts is an audit entity id (500 characters, each up to 3
// UTF-8 bytes, each byte percent-encoded); an object key is ASCII and at most
// 1024 characters. The whole URL fits an /oauth/authorize request with every
// parameter at its limit and every character percent-encoded.
export const MAX_PATH_BYTES = 8 * 1024;
export const MAX_URL_BYTES = 32 * 1024;

/**
 * Refuses an over-long URL with `414 uri_too_long` before anything else reads
 * it: Node's 200 KiB header limit would otherwise let every later middleware
 * and route walk a path that long. Answered here rather than thrown, because
 * the error handler logs the path.
 */
export const uriLength = (req: Request, res: Response, next: NextFunction) => {
  const url = req.url;
  const queryAt = url.indexOf("?");
  const pathBytes = Buffer.byteLength(
    queryAt === -1 ? url : url.slice(0, queryAt)
  );
  const urlBytes = Buffer.byteLength(url);
  if (urlBytes <= MAX_URL_BYTES && pathBytes <= MAX_PATH_BYTES) {
    next();
    return;
  }
  logger.warn(
    { method: req.method, pathBytes, urlBytes, status: 414 },
    "Request URL too long"
  );
  sendError(res, new UriTooLongError());
};
