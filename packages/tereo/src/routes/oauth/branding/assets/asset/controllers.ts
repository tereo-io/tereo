import type { CheckedImage } from "../../../../../utils/branding/images.js";
import { BRANDING_BUCKET } from "../../../../../utils/branding/storage.js";
import { MIME_BY_EXT } from "../../../../../utils/branding/images.js";
import { openBlobStream } from "../../../../../utils/storage.js";
import { NotFoundError } from "../../../../../utils/errors.js";
import { logger } from "../../../../../utils/logger.js";
import db from "../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import { AssetParamsSchema } from "./schemas.js";
import { pipeline } from "node:stream/promises";

export const getAsset = async (req: Request, res: Response) => {
  // A name that cannot be a branding key is a miss, not a bad request.
  const parsed = AssetParamsSchema.safeParse(req.params);
  if (!parsed.success) throw new NotFoundError("Asset not found");
  const { file } = parsed.data;

  const bucket = await db.buckets.getByName(BRANDING_BUCKET);
  const object = await db.objects.getByKey(bucket.id, file);
  const blob = object.versions[0]?.contentBlob;
  if (!blob) throw new NotFoundError("Asset not found");

  const ext = file.slice(file.lastIndexOf(".") + 1) as CheckedImage["ext"];
  const mime = MIME_BY_EXT[ext];
  res.set({
    // SVGs are checked as UTF-8, so the declared charset must agree.
    "Content-Type": ext === "svg" ? `${mime}; charset=utf-8` : mime,
    "Content-Length": String(blob.sizeBytes),
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    ...(ext === "svg" && {
      "Content-Security-Policy":
        "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    }),
  });
  res.removeHeader("Pragma");

  const stream = openBlobStream(
    {
      fsPath: blob.fsPath,
      keyMaterial: {
        wrappedDek: Buffer.from(blob.wrappedDek),
        iv: Buffer.from(blob.iv),
        masterKeyVersion: blob.masterKeyVersion,
      },
    },
    blob.hash
  );
  try {
    await pipeline(stream, res);
  } catch (err) {
    logger.error({ err, file }, "branding asset stream failed");
    res.destroy();
  }
};
