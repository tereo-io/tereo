import { isClaimHeld } from "../../../../../../../../../utils/uploadIdempotency.js";
import { setAccessLog } from "../../../../../../../../../middleware/accessLog.js";
import { validateParams } from "../../../../../../../../../utils/validateReq.js";
import { assertMultipartFits, multipartCompleteClaim } from "../../../utils.js";
import { validateUser } from "../../../../../../../../../middleware/auth.js";
import { stagePart } from "../../../../../../../../../utils/storage.js";
import { logger } from "../../../../../../../../../utils/logger.js";
import db from "../../../../../../../../../utils/db/index.js";
import env from "../../../../../../../../../env.js";
import { partParamsSchema } from "./schemas.js";
import { Request, Response } from "express";
import fs from "fs/promises";
import path from "path";
import {
  assertUploadInBucket,
  getAccessibleBucket,
  validateMultipartOwnership,
} from "../../../../../../../../../utils/bucketAccess.js";
import {
  AppError,
  ConflictError,
  PayloadTooLargeError,
} from "../../../../../../../../../utils/errors.js";

export const uploadPart = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const params = validateParams(partParamsSchema, req);

  const bucket = await getAccessibleBucket(auth, params.name, "write");
  const upload = await db.multipartUploads.getActive(params.uploadId);
  assertUploadInBucket(upload, bucket);
  validateMultipartOwnership(auth, upload.createdBy);

  // A declared length that cannot fit is refused before the body is read;
  // the staged size is checked again under the upload's lock below.
  const declared = Number(req.headers["content-length"]);
  if (Number.isSafeInteger(declared)) {
    const otherParts = await db.multipartUploads.stagedBytes(
      params.uploadId,
      params.partNumber
    );
    assertMultipartFits(upload, bucket, otherParts + BigInt(declared));
  }

  const stagingDek = db.multipartUploads.unwrapStagingDek(upload);
  const maxPartBytes = env.FILE_SERVICE_MAX_UPLOAD_SIZE_MB * 1024 * 1024;
  let staged: Awaited<ReturnType<typeof stagePart>>;
  try {
    staged = await stagePart(
      params.uploadId,
      params.partNumber,
      req,
      maxPartBytes,
      stagingDek
    );
  } catch (err) {
    // stagePart's Transform throws with LIMIT_FILE_SIZE when the cap is
    // exceeded. Translate into a clean 413 for the client.
    if (
      err instanceof Error &&
      (err as { code?: string }).code === "LIMIT_FILE_SIZE"
    ) {
      throw new PayloadTooLargeError(err.message);
    }
    throw err;
  }

  const minPart = env.FILE_SERVICE_MIN_PART_SIZE_MB * 1024 * 1024;
  // S3 allows the last part to be smaller — we don't know which is last, so
  // enforce min on all but allow the server to accept smaller parts and
  // validate at complete time.

  let priorFsPath: string | null;
  try {
    ({ priorFsPath } = await db.multipartUploads.upsertPart(
      {
        uploadId: params.uploadId,
        partNumber: params.partNumber,
        sizeBytes: BigInt(staged.sizeBytes),
        etag: staged.etag,
        fsPath: staged.fsPath,
      },
      {
        // The complete reads the parts while it assembles them; a part
        // replaced under it would unlink a file it is reading.
        assertNotCompleting: async () => {
          if (await isClaimHeld(multipartCompleteClaim(params.uploadId))) {
            throw new ConflictError(
              "This multipart upload is being completed; its parts can no longer change",
              "multipart_complete_in_progress"
            );
          }
        },
        assertFits: (otherParts) =>
          assertMultipartFits(
            upload,
            bucket,
            otherParts + BigInt(staged.sizeBytes)
          ),
      }
    ));
  } catch (err) {
    await fs.unlink(staged.fsPath).catch(() => {});
    // Staging recreated the dir of an upload finalized meanwhile; rmdir
    // leaves it if another part is still in it.
    if (err instanceof AppError && err.code === "upload_not_active") {
      await fs.rmdir(path.dirname(staged.fsPath)).catch(() => {});
    }
    throw err;
  }

  // A prior staged file (from an earlier retry of the same partNumber) is
  // displaced by this upsert — unlink it best-effort. Any leak survives until
  // the upload's `removeMultipartDir` at complete/abort/expire.
  if (priorFsPath) {
    await fs.unlink(priorFsPath).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(
          {
            uploadId: params.uploadId,
            partNumber: params.partNumber,
            priorFsPath,
            err,
          },
          "Failed to unlink displaced multipart part"
        );
      }
    });
  }

  setAccessLog(res, {
    bucketId: upload.bucketId,
    operation: "UPLOAD_PART",
  });

  res.status(200).json({
    partNumber: params.partNumber,
    etag: staged.etag,
    sizeBytes: staged.sizeBytes.toString(),
    minPartSize: minPart,
  });
};
