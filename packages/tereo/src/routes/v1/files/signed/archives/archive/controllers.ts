import { setContentDisposition } from "../../../buckets/bucket/objects/utils.js";
import { verify as presignVerify } from "../../../../../../utils/presigning.js";
import { SYSTEM_USER_ID } from "../../../../../../definitions/index.js";
import { logAuditTx } from "../../../../../../utils/outbox.js";
import { logger } from "../../../../../../utils/logger.js";
import db from "../../../../../../utils/db/index.js";
import { ArchiveIdSchema } from "./schemas.js";
import { Request, Response } from "express";
import env from "../../../../../../env.js";
import {
  ArchiveAbortedError,
  buildArchiveStream,
} from "../../../../../../utils/archiveStream.js";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  AppError,
  sendError,
} from "../../../../../../utils/errors.js";
import {
  stringParam,
  extractId,
  shareIdParam,
  signerParam,
  ensureShareStillServeable,
} from "../../utils.js";

/**
 * GET /signed/archives/:id
 *
 * Stream the zip/tar built from an ArchiveRequest snapshot. Auth is purely
 * the presigned signature — the archive row already encodes which bucket and
 * which object versions were authorized at create time, so no further
 * permission check is required. Only the recorded versions are served: an
 * entry whose object has been overwritten, deleted or purged since is left
 * out, and with none left the archive is `410`. Re-downloads within the
 * signed TTL are permitted (`downloadedAt` is recorded for the audit trail).
 */
export const downloadArchiveViaSignedUrl = async (
  req: Request,
  res: Response
) => {
  const id = extractId(req);
  // The id reaches the database before the signature is checked (the HMAC
  // binds the archive's bucket, which comes from its row).
  if (!ArchiveIdSchema.safeParse(id).success) {
    throw new NotFoundError("Archive not found");
  }

  // Archive rows carry their own bucket binding, so we resolve the bucket
  // from the DB first and then verify the HMAC against that bucket — the
  // signer included it in the canonical string when this URL was minted.
  // DB-sourced bucket is the authority; the URL itself doesn't have to
  // carry a bucket segment.
  const archive = await db.archives.get(id);
  if (archive.expiresAt.getTime() < Date.now()) {
    throw new ForbiddenError("Archive request expired");
  }
  const bucket = await db.buckets.get(archive.bucketId);

  const shareId = shareIdParam(req);
  const verified = presignVerify({
    bucket: bucket.name,
    id,
    operation: "archive",
    expires: stringParam(req, "expires"),
    nonce: stringParam(req, "nonce"),
    v: stringParam(req, "v"),
    sig: stringParam(req, "sig"),
    share: shareId,
    by: signerParam(req),
  });
  if (verified.operation !== "archive") {
    throw new ForbiddenError("Signature operation mismatch");
  }
  const objects = await db.archives.loadSnapshotForStreaming(archive.id);
  if (objects.length === 0) {
    throw new AppError(
      410,
      "archive_gone",
      "None of the archived objects still has the content it was archived with"
    );
  }
  // The snapshot only shrinks, so this catches a cap lowered since creation.
  const totalBytes = objects.reduce(
    (sum, o) => sum + o.contentBlob.sizeBytes,
    0n
  );
  if (totalBytes > BigInt(env.FILE_SERVICE_MAX_ARCHIVE_TOTAL_BYTES)) {
    throw new BadRequestError(
      "archive_too_large",
      `Archive would exceed ${env.FILE_SERVICE_MAX_ARCHIVE_TOTAL_BYTES} bytes.`
    );
  }
  await ensureShareStillServeable(verified);

  // Audit BEFORE streaming: once we start writing the body we can't send an
  // error response, and we want the download attempt recorded even if the
  // client disconnects mid-stream. No DB write here — the audit row goes
  // through the outbox in its own tx so a crash before dispatch still leaves
  // the row to be picked up.
  // Mirrors the single-object presigned download: CREATE on a
  // "archiveDownload" entity so the audit log has an entry every time a zip
  // is streamed (vs. every time an ArchiveRequest is minted, which is the
  // separate "archiveRequest" CREATE on the POST create path).
  await db.$transaction(async (tx) => {
    await logAuditTx(tx, {
      auth: { userId: verified.by ?? SYSTEM_USER_ID, email: null },
      organizationId: bucket.organizationId ?? undefined,
      action: "CREATE",
      entityType: "archiveDownload",
      entityId: archive.id,
      entityName: archive.filename,
      metadata: {
        bucketName: bucket.name,
        prefix: archive.prefix,
        objectCount: archive.objectCount,
        resolvedObjectCount: objects.length,
        totalSizeBytes: archive.totalSizeBytes.toString(),
        resolvedSizeBytes: totalBytes.toString(),
        format: archive.format,
        keyVersion: verified.keyVersion,
      },
    });
  });

  const format = archive.format === "tar" ? "tar" : "zip";
  const contentType =
    format === "tar" ? "application/x-tar" : "application/zip";
  res.setHeader("Content-Type", contentType);
  setContentDisposition(res, {
    contentType,
    objectKey: archive.filename,
    filenameOverride: archive.filename,
    forceAttachment: true,
  });
  // Deliberately omit Content-Length — the compressed archive size is not
  // known ahead of time; sending an incorrect value would let intermediaries
  // truncate or pad the response.
  res.setHeader("Cache-Control", "private, no-store");

  const { stream, finalized, abort } = buildArchiveStream({
    objects,
    format,
    stripPrefix: archive.prefix,
  });

  stream.on("error", (err) => {
    logger.warn(
      {
        archiveId: archive.id,
        err,
      },
      "Archive stream error"
    );
    if (!res.headersSent) {
      sendError(
        res,
        new AppError(500, "server_error", "Failed to build archive")
      );
      return;
    }
    // Headers already sent — destroy the socket so the client sees truncation.
    res.destroy(err);
  });

  // `.pipe` only unpipes when the client goes away; this stops the archive
  // and closes the blob it is reading.
  res.on("close", () => {
    if (!res.writableFinished) abort();
  });
  stream.pipe(res);

  try {
    await finalized;
  } catch (err) {
    if (err instanceof ArchiveAbortedError) {
      logger.debug({ archiveId: archive.id }, "Archive download abandoned");
      return;
    }
    logger.warn(
      {
        archiveId: archive.id,
        err,
      },
      "Archive finalization failed"
    );
    return;
  }

  // Mark the download complete for the audit trail. Fire-and-forget — if the
  // update fails the archive is still downloadable until it expires.
  db.archives.markDownloaded(archive.id).catch((err) => {
    logger.warn(
      {
        archiveId: archive.id,
        err,
      },
      "Failed to mark archive downloaded"
    );
  });
};
