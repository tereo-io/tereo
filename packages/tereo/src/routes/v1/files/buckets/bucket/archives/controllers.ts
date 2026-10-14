import { getAccessibleBucket } from "../../../../../../utils/bucketAccess.js";
import { setAccessLog } from "../../../../../../middleware/accessLog.js";
import { validateUser } from "../../../../../../middleware/auth.js";
import { BadRequestError } from "../../../../../../utils/errors.js";
import { logAuditTx } from "../../../../../../utils/outbox.js";
import { createArchiveBodySchema } from "./schemas.js";
import db from "../../../../../../utils/db/index.js";
import { bucketNameSchema } from "../../schemas.js";
import { Request, Response } from "express";
import env from "../../../../../../env.js";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";
import {
  assertPresignTtl,
  sign as presignSign,
} from "../../../../../../utils/presigning.js";

const ARCHIVE_FILENAME_FALLBACK = "archive";

/**
 * POST /buckets/:name/archives
 *
 * Create a snapshot archive request for either a prefix (folder download) or
 * an explicit list of keys (multi-select). Returns a presigned URL that is
 * the only way to download the archive — there is no authenticated-session
 * shortcut, so the same flow covers both "download now" and "shareable link"
 * use cases. The snapshot records each object's current version: an object
 * overwritten, deleted or purged afterwards is left out of the download, and
 * objects uploaded under the prefix afterwards are not added.
 */
export const createArchive = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { name } = validateParams(bucketNameSchema, req);
  const body = validateBody(createArchiveBodySchema, req);
  // Checked again by the signing below; up front it spares the resolution
  // queries.
  assertPresignTtl(body.expiresInSeconds);

  const bucket = await getAccessibleBucket(auth, name, "read");

  const maxObjects = env.FILE_SERVICE_MAX_ARCHIVE_OBJECTS;

  let objectIds: string[];
  if (body.prefix !== undefined) {
    const ids = await db.archives.enumerateObjectIdsForPrefix(
      bucket.id,
      body.prefix,
      maxObjects
    );
    if (ids.length > maxObjects) {
      throw new BadRequestError(
        "archive_too_large",
        `Prefix matches more than ${maxObjects} objects. Narrow the prefix or request individual keys.`
      );
    }
    objectIds = ids;
  } else {
    const keys = body.keys ?? [];
    const resolved = await db.archives.resolveObjectIdsByKeys(bucket.id, keys);
    objectIds = resolved.map((r) => r.id);
  }

  const loaded = await db.archives.loadObjectsForStreaming(objectIds);
  if (loaded.length === 0) {
    throw new BadRequestError(
      "archive_empty",
      body.prefix !== undefined
        ? `No objects matched prefix "${body.prefix}"`
        : "None of the provided keys matched a live object"
    );
  }

  const totalBytes = loaded.reduce(
    (sum, o) => sum + o.contentBlob.sizeBytes,
    0n
  );
  const maxBytes = BigInt(env.FILE_SERVICE_MAX_ARCHIVE_TOTAL_BYTES);
  if (totalBytes > maxBytes) {
    throw new BadRequestError(
      "archive_too_large",
      `Archive would exceed ${env.FILE_SERVICE_MAX_ARCHIVE_TOTAL_BYTES} bytes. Narrow the selection.`
    );
  }

  const expiresAt = new Date(Date.now() + body.expiresInSeconds * 1000);
  const filename = sanitizeFilename(
    body.format,
    body.filename ?? deriveFilename(body.prefix, body.format)
  );

  // Signed inside the transaction, so a signing failure leaves no archive row
  // or audit entry behind.
  const { archive, signed } = await db.$transaction(async (tx) => {
    const a = await db.archives.create(
      {
        bucketId: bucket.id,
        prefix: body.prefix ?? null,
        versionIds: loaded.map((o) => o.versionId),
        format: body.format,
        filename,
        totalSizeBytes: totalBytes,
        expiresAt,
        createdByUserId: auth.userId,
      },
      tx
    );

    await logAuditTx(tx, {
      auth,
      organizationId: bucket.organizationId ?? undefined,
      action: "CREATE",
      entityType: "archiveRequest",
      entityId: a.id,
      entityName: filename,
      metadata: {
        bucketName: bucket.name,
        prefix: body.prefix ?? null,
        keyCount: body.keys?.length ?? null,
        objectCount: loaded.length,
        totalSizeBytes: totalBytes.toString(),
        format: body.format,
        expiresAt: expiresAt.toISOString(),
      },
    });

    const signed = presignSign({
      bucket: name,
      id: a.id,
      operation: "archive",
      expiresInSeconds: body.expiresInSeconds,
    });

    return { archive: a, signed };
  });

  setAccessLog(res, {
    bucketId: bucket.id,
    operation: "CREATE_ARCHIVE",
  });

  res.status(201).json({
    id: archive.id,
    url: signed.url,
    expiresAt: expiresAt.toISOString(),
    objectCount: loaded.length,
    totalSizeBytes: totalBytes.toString(),
    format: body.format,
    filename,
  });
};

function deriveFilename(prefix: string | undefined, format: string): string {
  if (!prefix) return `${ARCHIVE_FILENAME_FALLBACK}.${format}`;
  const trimmed = prefix.replace(/\/+$/, "");
  const last = trimmed.split("/").filter(Boolean).pop();
  return `${last ?? ARCHIVE_FILENAME_FALLBACK}.${format}`;
}

/**
 * Strip characters that would confuse Content-Disposition or filesystems on
 * the client side. We keep this conservative — path separators and control
 * characters only — so user-supplied names survive recognizably.
 */
function sanitizeFilename(format: string, name: string): string {
  // eslint-disable-next-line no-control-regex -- intentionally strips control chars that break Content-Disposition / filesystems
  const cleaned = name.replace(/[\x00-\x1f/\\]/g, "_").trim();
  return cleaned.length > 0
    ? cleaned
    : `${ARCHIVE_FILENAME_FALLBACK}.${format}`;
}
