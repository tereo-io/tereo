import { sendError, UriTooLongError } from "../utils/errors.js";
import type { NextFunction, Request, Response } from "express";
import { logger } from "../utils/logger.js";

// Bytes of the request path as sent, percent-encoding included. The longest
// path a route accepts is an audit entity id (500 characters, each up to 3
// UTF-8 bytes, each byte percent-encoded); an object key is ASCII and at most
// 1024 characters. The query string is not limited here: list filters and
// /oauth/authorize parameters can legally run long, and Node's 200 KiB header
// limit bounds it.
export const MAX_PATH_BYTES = 8 * 1024;

/**
 * Refuses an over-long path with `414 uri_too_long` before anything else
 * reads it: Node's header limit would otherwise let every later middleware
 * and route walk a path that long. Answered here rather than thrown, because
 * the error handler logs the path.
 */
export const uriLength = (req: Request, res: Response, next: NextFunction) => {
  const url = req.url;
  const queryAt = url.indexOf("?");
  const pathBytes = Buffer.byteLength(
    queryAt === -1 ? url : url.slice(0, queryAt)
  );
  if (pathBytes <= MAX_PATH_BYTES) {
    next();
    return;
  }
  logger.warn(
    { method: req.method, pathBytes, status: 414 },
    "Request URL too long"
  );
  sendError(res, new UriTooLongError());
};
