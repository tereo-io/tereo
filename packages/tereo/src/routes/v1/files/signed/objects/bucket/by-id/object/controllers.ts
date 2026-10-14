import { emitObjectWrittenTx } from "../../../../../buckets/bucket/objects/events.js";
import { assertBucketWritable } from "../../../../../../../../utils/bucketAccess.js";
import { createEncryptStream } from "../../../../../../../../utils/encryption.js";
import { parseContentType } from "../../../../../../../../utils/contentType.js";
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
  ensureShareStillServeable,
  verifiedSignedUrl,
} from "../../../../utils.js";

export const downloadViaSignedUrl = async (req: Request, res: Response) => {
  const id = extractId(req);
  const bucketName = extractBucketName(req);
  const verified = verifiedSignedUrl(res);
  await ensureShareStillServeable(verified);

  const bucket = await db.buckets.getByName(bucketName);
  // Signature binds the id, so a rename between signing and download still
  // resolves to the same object. The current version's bytes are streamed,
  // unless the URL pins one (a share of a specific version).
  const object = await db.objects.getById(bucket.id, id);
  const current = verified.version
    ? await db.objectVersions.getByVersionId(object.id, verified.version)
    : object.versions[0];
  if (!current || !current.contentBlob || current.isDeleteMarker) {
    throw new NotFoundError("Object has no current content");
  }
  const blob = current.contentBlob;

  // Presigned downloads authenticate by HMAC, not userId. Record via audit log
  // so we have a trail of who signed the URL (keyVersion) and what it pointed
  // at. The caller is the signed URL's issuer (best-effort anonymous). No DB
  // write occurs on read; the audit row goes through the outbox in a tiny tx.
  await db.$transaction(async (tx) => {
    await logAuditTx(tx, {
      auth: { userId: verified.by ?? SYSTEM_USER_ID, email: null },
      organizationId: bucket.organizationId ?? undefined,
      action: "CREATE",
      entityType: "presignedDownload",
      entityId: String(object.id),
      entityName: object.objectKey,
      metadata: {
        bucketName: bucket.name,
        objectKey: object.objectKey,
        objectId: id,
        versionId: current.id,
        keyVersion: verified.keyVersion,
      },
    });
  });

  res.setHeader(
    "Content-Type",
    current.contentType ?? "application/octet-stream"
  );
  res.setHeader("ETag", `"${current.etag ?? ""}"`);
  res.setHeader("Cache-Control", "private, max-age=60");
  // Parity with the authenticated download paths: never let the browser sniff a
  // content type other than the one we declare.
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Disposition default is content-type driven (setContentDisposition): unsafe
  // types like text/html, text/javascript, and image/svg+xml are always served
  // as attachments so a signed link to user-uploaded content can't execute
  // script in our origin. The `?disposition`/`?filename` query params are a
  // presentation-only hint NOT in the HMAC canonical, so a caller can flip them
  // without invalidating the signature — this is the intended affordance for
  // share links forcing attachment on otherwise-inline types.
  //
  // Trust boundary: treat both values as fully untrusted user input.
  //  - `disposition`: only the literal string `"attachment"` is honored, and it
  //    can only *strengthen* the default (force attachment). It can never
  //    request `inline`, so a tampered URL can't weaken disposition.
  //  - `filename`: sanitized inside setContentDisposition (control chars,
  //    double-quote, backslash → `_`) to prevent header injection; emitted as
  //    an ASCII `filename=` and the real name in RFC 5987 `filename*=`.
  const forceAttachment = req.query.disposition === "attachment";
  setContentDisposition(res, {
    contentType: current.contentType ?? "application/octet-stream",
    objectKey: object.objectKey,
    filenameOverride:
      typeof req.query.filename === "string" ? req.query.filename : null,
    forceAttachment,
  });

  await sendBlobBody(req, res, blob, { etag: current.etag ?? "" });
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

  res.setHeader("ETag", `"${result.body.etag}"`);
  res.status(result.type === "updated" ? 200 : 201).json(result.body);
};
