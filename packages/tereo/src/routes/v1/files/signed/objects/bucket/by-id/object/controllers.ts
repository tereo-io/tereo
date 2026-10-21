import { answerReadPreconditions } from "../../../../../../../../utils/conditionalRequests.js";
import { broadcastObjectInvalidate } from "../../../../../../../../utils/cacheBroadcast.js";
import { emitObjectWrittenTx } from "../../../../../buckets/bucket/objects/events.js";
import { assertBucketWritable } from "../../../../../../../../utils/bucketAccess.js";
import { createEncryptStream } from "../../../../../../../../utils/encryption.js";
import { parseContentType } from "../../../../../../../../utils/contentType.js";
import { setAccessLog } from "../../../../../../../../middleware/accessLog.js";
import { SYSTEM_USER_ID } from "../../../../../../../../definitions/index.js";
import { logAuditTx } from "../../../../../../../../utils/outbox.js";
import db from "../../../../../../../../utils/db/index.js";
import env from "../../../../../../../../env.js";
import { Readable, Transform } from "stream";
import { Request, Response } from "express";
import { createWriteStream } from "fs";
import fs from "fs/promises";
import crypto from "crypto";
import path from "path";
import {
  assertObjectKeyNotReserved,
  queueObjectWriteFollowUps,
  sendBlobBody,
  serializeObject,
  setContentDisposition,
  validateMimeType,
} from "../../../../../buckets/bucket/objects/utils.js";
import {
  assertUnreadBody,
  getBlobPath,
} from "../../../../../../../../utils/storage.js";
import {
  PayloadTooLargeError,
  ForbiddenError,
  NotFoundError,
} from "../../../../../../../../utils/errors.js";
import {
  MIME_SNIFF_BYTES,
  pipeline,
  extractId,
  extractBucketName,
  assertShareServeable,
  assertSignerMayAccess,
  auditAndSpendShareUrl,
  forcesAttachment,
  verifiedSignedUrl,
} from "../../../../utils.js";

const resolveSignedDownload = async (req: Request, res: Response) => {
  const id = extractId(req);
  const verified = verifiedSignedUrl(res);
  const share = await assertShareServeable(verified);

  const bucket = await db.buckets.getByName(extractBucketName(req));
  if (!share && verified.by) {
    await assertSignerMayAccess(verified.by, bucket, "read");
  }
  // Signature binds the id, so a rename between signing and download still
  // resolves to the same object. The current version's bytes are served,
  // unless the URL pins one (a share of a specific version).
  const object = await db.objects.getById(bucket.id, id);
  const current = verified.version
    ? await db.objectVersions.getByVersionId(object.id, verified.version)
    : object.versions[0];
  if (!current || !current.contentBlob || current.isDeleteMarker) {
    throw new NotFoundError("Object has no current content");
  }
  const contentType = current.contentType ?? "application/octet-stream";
  const etag = current.etag ?? "";
  const lastModified = verified.version ? current.createdAt : object.updatedAt;

  res.setHeader("Content-Type", contentType);
  res.setHeader("ETag", `"${etag}"`);
  res.setHeader("Last-Modified", lastModified.toUTCString());
  res.setHeader("Cache-Control", "private, max-age=60");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Unsafe types (text/html, image/svg+xml, …) are always attachments, so a
  // signed link to uploaded content can't run script in our origin.
  // `?disposition=attachment` is unsigned but can only force attachment; a
  // filename is honored only when the signature binds it.
  setContentDisposition(res, {
    contentType,
    objectKey: object.objectKey,
    filenameOverride: verified.filename,
    forceAttachment: forcesAttachment(req),
  });

  return {
    verified,
    share,
    bucket,
    object,
    current,
    blob: current.contentBlob,
    etag,
    lastModified,
  };
};

export const probeViaSignedUrl = async (req: Request, res: Response) => {
  const { blob, etag, lastModified } = await resolveSignedDownload(req, res);
  if (answerReadPreconditions(req, res, { etag, lastModified })) return;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Length", blob.sizeBytes.toString());
  res.status(200).end();
};

export const downloadViaSignedUrl = async (req: Request, res: Response) => {
  const { verified, share, bucket, object, current, blob, etag, lastModified } =
    await resolveSignedDownload(req, res);
  // A 304 sends no body, so it spends no nonce and writes no audit row.
  if (answerReadPreconditions(req, res, { etag, lastModified })) return;

  setAccessLog(res, {
    bucketId: bucket.id,
    objectId: object.id,
    operation: "PRESIGNED_DOWNLOAD",
  });

  await sendBlobBody(
    req,
    res,
    blob,
    { etag, lastModified },
    {
      beforeBody: () =>
        auditAndSpendShareUrl(verified, share, (tx) =>
          logAuditTx(tx, {
            auth: { userId: verified.by ?? SYSTEM_USER_ID, email: null },
            organizationId: bucket.organizationId ?? undefined,
            action: "CREATE",
            entityType: "presignedDownload",
            entityId: String(object.id),
            entityName: object.objectKey,
            metadata: {
              bucketName: bucket.name,
              objectKey: object.objectKey,
              objectId: object.id,
              versionId: current.id,
              keyVersion: verified.keyVersion,
            },
          })
        ),
    }
  );
};

export const uploadViaSignedUrl = async (req: Request, res: Response) => {
  const id = extractId(req);
  const bucketName = extractBucketName(req);
  const verified = verifiedSignedUrl(res);
  // Shares are download-only by design — a `share` binding on a write URL is
  // categorically invalid and means a tampered (or forged) URL slipped past
  // HMAC verification, which can't happen but is asserted here for defense.
  if (verified.share || verified.version) {
    throw new ForbiddenError("Share binding not permitted for writes");
  }

  const bucket = await db.buckets.getByName(bucketName);
  if (verified.by) await assertSignerMayAccess(verified.by, bucket, "write");
  assertBucketWritable(bucket);
  // Fails fast before the body streams; the write itself goes by id, so a
  // rename meanwhile lands it under the object's new key.
  const existing = await db.objects.getById(bucket.id, id);
  assertObjectKeyNotReserved(existing.objectKey);
  const contentType = parseContentType(
    (req.headers["content-type"] as string | undefined) ??
      "application/octet-stream"
  );
  const maxBytes = env.FILE_SERVICE_MAX_UPLOAD_SIZE_MB * 1024 * 1024;

  const plaintextHasher = crypto.createHash("sha256");
  const md5Hasher = crypto.createHash("md5");
  let plaintextSize = 0;
  // Capture the first MIME_SNIFF_BYTES of plaintext so we can run the same
  // executable/MIME blocklist that authenticated uploads get.
  const sniffChunks: Buffer[] = [];
  let sniffBytes = 0;

  const plaintextMeter = new Transform({
    transform(chunk, _enc, cb) {
      plaintextSize += chunk.length;
      if (plaintextSize > maxBytes) {
        return cb(new PayloadTooLargeError("Upload exceeds max size"));
      }
      plaintextHasher.update(chunk);
      md5Hasher.update(chunk);
      if (sniffBytes < MIME_SNIFF_BYTES) {
        const need = MIME_SNIFF_BYTES - sniffBytes;
        const slice = chunk.length > need ? chunk.subarray(0, need) : chunk;
        sniffChunks.push(Buffer.from(slice));
        sniffBytes += slice.length;
      }
      cb(null, chunk);
    },
  });

  const { stream: encryptStream, finalize } = createEncryptStream();
  const tempPath = path.join(
    env.FILE_SERVICE_TEMP_PATH,
    `signed-upload-${crypto.randomBytes(8).toString("hex")}`
  );
  await fs.mkdir(env.FILE_SERVICE_TEMP_PATH, { recursive: true });

  try {
    assertUnreadBody(req);
    await pipeline(
      req as unknown as Readable,
      plaintextMeter,
      encryptStream,
      createWriteStream(tempPath)
    );
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }

  // Enforce the same MIME/executable blocklist that authenticated uploads get.
  // Done after the stream finishes but before the blob is attached, so a
  // rejected upload never appears in the blob tree.
  try {
    await validateMimeType({
      buffer: Buffer.concat(sniffChunks),
      mimetype: contentType,
    });
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }

  const hash = plaintextHasher.digest("hex");
  const etag = md5Hasher.digest("hex");
  const fsPath = getBlobPath(hash);
  const keyMaterial = finalize(hash);

  let result;
  try {
    // Heavy I/O finished above; the transaction is purely DB work + outbox.
    result = await db.$transaction(async (tx) => {
      const upsert = await db.objects.upsertWithBlob(
        {
          bucketId: bucket.id,
          objectKey: existing.objectKey,
          objectId: id,
          contentType,
          sizeBytes: BigInt(plaintextSize),
          contentBlobHash: hash,
          etag,
          createdBy: verified.by ?? SYSTEM_USER_ID,
          stagedPath: tempPath,
        },
        fsPath,
        keyMaterial,
        tx
      );

      const serialized = serializeObject(upsert.object);

      await logAuditTx(tx, {
        auth: { userId: verified.by ?? SYSTEM_USER_ID, email: null },
        organizationId: bucket.organizationId ?? undefined,
        action: upsert.type === "updated" ? "UPDATE" : "CREATE",
        entityType: "object",
        entityId: String(upsert.object.id),
        entityName: upsert.object.objectKey,
        metadata: {
          bucketName: bucket.name,
          objectKey: serialized.key,
          objectId: id,
          via: "presigned",
          keyVersion: verified.keyVersion,
        },
      });

      await emitObjectWrittenTx(tx, bucket, upsert, "presigned");

      return { ...upsert, body: serialized };
    });
  } catch (err) {
    await db.contentBlobs.releaseStaged({ hash, fsPath, stagedPath: tempPath });
    throw err;
  }

  queueObjectWriteFollowUps(
    bucket,
    result.object.id,
    contentType,
    result.releasedBlobHashes
  );
  await broadcastObjectInvalidate(bucket.name, result.object.objectKey);

  setAccessLog(res, {
    bucketId: bucket.id,
    objectId: result.object.id,
    operation: "PRESIGNED_UPLOAD",
  });
  res.setHeader("ETag", `"${result.body.etag}"`);
  res.status(result.type === "updated" ? 200 : 201).json(result.body);
};
