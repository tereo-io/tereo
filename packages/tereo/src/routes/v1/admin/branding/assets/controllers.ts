import { storeBrandingImage } from "../../../../../utils/branding/storage.js";
import { validateBody } from "../../../../../utils/validateReq.js";
import { BadRequestError } from "../../../../../utils/errors.js";
import { validateUser } from "../../../../../utils/auth.js";
import { uploadAssetBodySchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  brandingAssetUrl,
  checkImage,
} from "../../../../../utils/branding/images.js";

export const uploadAsset = async (req: Request, res: Response) => {
  const { userId } = validateUser(req);
  const { slot } = validateBody(uploadAssetBodySchema, req);

  if (!req.file) {
    throw new BadRequestError("file_upload_required", "No file was uploaded");
  }

  const image = await checkImage(slot, req.file.buffer);
  const stored = await storeBrandingImage(image, userId);

  res.status(201).json({
    sha256: image.sha256,
    ext: image.ext,
    url: brandingAssetUrl(stored.objectKey),
  });
};
