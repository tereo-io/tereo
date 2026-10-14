import { getMaxFileSizeBytes } from "../../../../utils/userPhotos.js";
import { Request, Response, NextFunction } from "express";
import multer from "multer";
import {
  SINGLE_FILE_FIELD_LIMITS,
  TOO_LARGE_MULTER_CODES,
} from "../../../../utils/multipartLimits.js";
import {
  BadRequestError,
  PayloadTooLargeError,
} from "../../../../utils/errors.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: getMaxFileSizeBytes(),
    files: 1,
    ...SINGLE_FILE_FIELD_LIMITS,
  },
});

// Multer's errors carry a `code` but no status, so they would reach the
// error handler as 500s. Same mapping as the files upload route.
export const handleMulterErrors = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  upload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return next(
        new PayloadTooLargeError(
          `File too large. Maximum size: ${getMaxFileSizeBytes() / 1024 / 1024}MB`
        )
      );
    }
    if (
      err instanceof multer.MulterError &&
      TOO_LARGE_MULTER_CODES.has(err.code)
    ) {
      return next(new PayloadTooLargeError(err.message));
    }
    next(
      new BadRequestError(
        "invalid_request",
        err instanceof Error ? err.message : "File upload error"
      )
    );
  });
};
