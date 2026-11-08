import { assertMayEditSomeBranding } from "../../../../../utils/branding/access.js";
import { imageMaxBytes } from "../../../../../utils/branding/images.js";
import { validateUser } from "../../../../../utils/auth.js";
import { Request, Response, NextFunction } from "express";
import multer from "multer";
import {
  SINGLE_FILE_FIELD_LIMITS,
  TOO_LARGE_MULTER_CODES,
} from "../../../../../utils/multipartLimits.js";
import {
  BadRequestError,
  PayloadTooLargeError,
} from "../../../../../utils/errors.js";

// The background is the largest slot; the controller applies the slot's own
// limit once the slot field is known.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: imageMaxBytes("background"),
    files: 1,
    ...SINGLE_FILE_FIELD_LIMITS,
  },
});

// Multer's errors carry a `code` but no status, so they would reach the
// error handler as 500s. Same mapping as the account photo route.
export const handleMulterErrors = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  upload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    if (
      err instanceof multer.MulterError &&
      (err.code === "LIMIT_FILE_SIZE" || TOO_LARGE_MULTER_CODES.has(err.code))
    ) {
      return next(
        new PayloadTooLargeError(
          err.code === "LIMIT_FILE_SIZE"
            ? "The image is too large"
            : err.message
        )
      );
    }
    next(
      new BadRequestError(
        "invalid_request",
        err instanceof Error ? err.message : "File upload error"
      )
    );
  });
};

// Before multer reads the body, so a caller who could never use the image
// is refused without the upload being buffered.
export const requireBrandingEditor = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    await assertMayEditSomeBranding(validateUser(req));
    next();
  } catch (err) {
    next(err);
  }
};
