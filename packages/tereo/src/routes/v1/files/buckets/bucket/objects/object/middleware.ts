import { Request, Response, NextFunction } from "express";
import env from "../../../../../../../env.js";
import fs from "fs/promises";
import multer from "multer";
import crypto from "crypto";
import {
  SINGLE_FILE_FIELD_LIMITS,
  TOO_LARGE_MULTER_CODES,
} from "../../../../../../../utils/multipartLimits.js";
import {
  BadRequestError,
  InsufficientStorageError,
  PayloadTooLargeError,
} from "../../../../../../../utils/errors.js";

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, env.FILE_SERVICE_TEMP_PATH),
    filename: (_req, _file, cb) =>
      cb(null, `upload-${crypto.randomBytes(12).toString("hex")}`),
  }),
  limits: {
    fileSize: env.FILE_SERVICE_MAX_UPLOAD_SIZE_MB * 1024 * 1024,
    files: 1,
    ...SINGLE_FILE_FIELD_LIMITS,
  },
});

const isSystemError = (err: unknown): err is NodeJS.ErrnoException =>
  err instanceof Error &&
  typeof (err as NodeJS.ErrnoException).syscall === "string";

export const handleMulterErrors = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  upload.single("file")(req, res, async (err: unknown) => {
    try {
      if (err) {
        // Multer may have already staged a partial temp file before its
        // internal size check fired — unlink it so we don't leak.
        if (req.file?.path) {
          await fs.unlink(req.file.path).catch(() => {});
        }
        if (err instanceof multer.MulterError) {
          if (TOO_LARGE_MULTER_CODES.has(err.code)) {
            throw new PayloadTooLargeError(err.message);
          }
          throw new BadRequestError("invalid_request", err.message);
        }
        // A system error is the temp directory failing (ENOENT, EACCES, …),
        // not the request; its message names the temp path, so it is not
        // passed on.
        if (isSystemError(err)) {
          if (err.code === "ENOSPC") {
            throw new InsufficientStorageError(
              "No space left to stage the upload"
            );
          }
          throw err;
        }
        // What is left is busboy refusing a malformed multipart body.
        throw new BadRequestError(
          "invalid_request",
          err instanceof Error ? err.message : "Malformed multipart body"
        );
      }
      // Defensive belt-and-suspenders cap in case multer's internal counter
      // disagreed with the on-disk size.
      if (
        req.file &&
        req.file.size > env.FILE_SERVICE_MAX_UPLOAD_SIZE_MB * 1024 * 1024
      ) {
        if (req.file.path) {
          await fs.unlink(req.file.path).catch(() => {});
        }
        throw new PayloadTooLargeError(
          "Upload exceeds configured maximum size"
        );
      }
      next();
    } catch (e) {
      next(e);
    }
  });
};
