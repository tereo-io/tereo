import { NextFunction, Request, Response } from "express";
import {
  extractId,
  extractBucketName,
  verifySignedQuery,
} from "../../../../utils.js";

/**
 * Checks an object URL's signature for `operation` before anything else runs
 * — the per-bucket rate limiter included, so an unsigned request can't make
 * it look up (and cache) whatever bucket name it carries.
 */
export const verifySignedObjectUrl =
  (operation: "read" | "write") =>
  (req: Request, res: Response, next: NextFunction) => {
    res.locals.signedUrl = verifySignedQuery(req, {
      bucket: extractBucketName(req),
      id: extractId(req),
      operation,
    });
    next();
  };
