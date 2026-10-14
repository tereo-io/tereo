import { verify as presignVerify } from "../../../../../../../../utils/presigning.js";
import { ForbiddenError } from "../../../../../../../../utils/errors.js";
import { NextFunction, Request, Response } from "express";
import {
  stringParam,
  extractId,
  extractBucketName,
  shareIdParam,
  signerParam,
  versionParam,
} from "../../../../utils.js";

/**
 * Checks an object URL's signature for `operation` before anything else runs
 * — the per-bucket rate limiter included, so an unsigned request can't make
 * it look up (and cache) whatever bucket name it carries.
 */
export const verifySignedObjectUrl =
  (operation: "read" | "write") =>
  (req: Request, res: Response, next: NextFunction) => {
    const verified = presignVerify({
      bucket: extractBucketName(req),
      id: extractId(req),
      operation,
      expires: stringParam(req, "expires"),
      nonce: stringParam(req, "nonce"),
      v: stringParam(req, "v"),
      sig: stringParam(req, "sig"),
      share: shareIdParam(req),
      by: signerParam(req),
      version: versionParam(req),
    });
    if (verified.operation !== operation) {
      throw new ForbiddenError("Signature operation mismatch");
    }
    res.locals.signedUrl = verified;
    next();
  };
