import { setContentDisposition } from "../../../buckets/bucket/objects/utils.js";
import { setAccessLog } from "../../../../../../middleware/accessLog.js";
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
  extractId,
  assertShareServeable,
  assertSignerMayAccess,
  spendShareUrl,
  verifySignedQuery,
} from "../../utils.js";

const orNull = <T>(lookup: Promise<T>): Promise<T | null> =>
  lookup.catch((err) => {
    if (err instanceof NotFoundError) return null;
    throw err;
  });

/**
 * The archive behind a signed URL, once the signature verifies. The HMAC
 * binds the archive's bucket, which comes from its row, so the row is read
 * first — but until the signature verifies, a missing archive is answered
 * exactly like a wrong signature, so the URL is no oracle for archive ids.
 */
const resolveSignedArchive = async (req: Request) => {
  const id = extractId(req);
  // A malformed id can't name any archive, so its 404 says nothing about one.
  if (!ArchiveIdSchema.safeParse(id).success) {
    throw new NotFoundError("Archive not found");
  }
  const archive = await orNull(db.archives.get(id));
  const bucket = archive
    ? await orNull(db.buckets.get(archive.bucketId))
    : null;
  const verified = verifySignedQuery(req, {
    // An unmatchable name: the signature check fails as for a wrong signature.
    bucket: bucket?.name ?? "",
    id,
    operation: "archive",
  });
  if (!archive || !bucket) throw new ForbiddenError("Invalid signature");
  if (archive.expiresAt.getTime() < Date.now()) {
    throw new ForbiddenError("Archive request expired");
  }

  const share = await assertShareServeable(verified);
  // The archive's creator signed its URL; a share's URL follows the share.
  const signer = verified.by ?? archive.createdByUserId;
  if (!share && signer) await assertSignerMayAccess(signer, bucket, "read");

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
  return { verified, share, signer, archive, bucket, objects, totalBytes };
};

const setArchiveHeaders = (
  res: Response,
  archive: { format: string; filename: string }
) => {
  const contentType =
    archive.format === "tar" ? "application/x-tar" : "application/zip";
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
};

/** HEAD /signed/archives/:id: what GET would answer, without spending the URL. */
export const probeArchiveViaSignedUrl = async (req: Request, res: Response) => {
  const { archive } = await resolveSignedArchive(req);
  setArchiveHeaders(res, archive);
  res.status(200).end();
};

/**
 * GET /signed/archives/:id
 *
 * Streams the zip/tar built from an ArchiveRequest snapshot: only the
 * recorded versions are served, and with none left the archive is `410`.
 * Re-downloads within the signed TTL are permitted (`downloadedAt` is
 * recorded for the audit trail).
 */
export const downloadArchiveViaSignedUrl = async (
  req: Request,
  res: Response
) => {
  const { verified, share, signer, archive, bucket, objects, totalBytes } =
    await resolveSignedArchive(req);

  // Audited before streaming, since an error can't be answered once the body
  // starts; in one transaction with the nonce, so a spent URL leaves no row.
  await db.$transaction(async (tx) => {
    await logAuditTx(tx, {
      auth: { userId: signer ?? SYSTEM_USER_ID, email: null },
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
    await spendShareUrl(verified, share);
  });

  setAccessLog(res, { bucketId: bucket.id, operation: "ARCHIVE_DOWNLOAD" });
  setArchiveHeaders(res, archive);

  const { stream, finalized, abort } = buildArchiveStream({
    objects,
    format: archive.format === "tar" ? "tar" : "zip",
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
