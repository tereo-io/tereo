import { createEncryptStream } from "../../../../../../../utils/encryption.js";
import { setAccessLog } from "../../../../../../../middleware/accessLog.js";
import { logAuditTx, emitTx } from "../../../../../../../utils/outbox.js";
import { completeBodySchema, uploadIdParamsSchema } from "./schemas.js";
import { validateUser } from "../../../../../../../middleware/auth.js";
import { Readable, Transform, pipeline as pipelineCb } from "stream";
import { emitObjectWrittenTx } from "../../objects/events.js";
import db from "../../../../../../../utils/db/index.js";
import { assertMultipartFits } from "../utils.js";
import env from "../../../../../../../env.js";
import { Request, Response } from "express";
import { createWriteStream } from "fs";
import { promisify } from "util";
import fs from "fs/promises";
import crypto from "crypto";
import path from "path";
import {
  canonicalJson,
  findStoredResponse,
  requireIdempotencyKey,
  withExclusiveClaim,
  withIdempotency,
} from "../../../../../../../utils/uploadIdempotency.js";
import {
  assertUploadInBucket,
  getAccessibleBucket,
  validateMultipartOwnership,
} from "../../../../../../../utils/bucketAccess.js";
import {
  validateBody,
  validateParams,
} from "../../../../../../../utils/validateReq.js";
import {
  getBlobPath,
  openMultipartPartStream,
  removeMultipartDir,
} from "../../../../../../../utils/storage.js";
import {
  BadRequestError,
  ConflictError,
} from "../../../../../../../utils/errors.js";
import {
  queueObjectWriteFollowUps,
  serializeObject,
  validateMimeType,
} from "../../objects/utils.js";

const pipeline = promisify(pipelineCb);

// Enough for the magic bytes `file-type` looks for, as on presigned uploads.
const MIME_SNIFF_BYTES = 4 * 1024;

export const listMultipartParts = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const params = validateParams(uploadIdParamsSchema, req);

  const bucket = await getAccessibleBucket(auth, params.name, "read");
  const upload = await db.multipartUploads.getAny(params.uploadId);
  assertUploadInBucket(upload, bucket);

  const parts = await db.multipartUploads.listParts(params.uploadId);

  setAccessLog(res, {
    bucketId: upload.bucketId,
    operation: "LIST_MULTIPART_PARTS",
  });

  res.json({
    uploadId: upload.id,
    objectKey: upload.objectKey,
    contentType: upload.contentType,
    expiresAt: upload.expiresAt,
    completedAt: upload.completedAt,
    abortedAt: upload.abortedAt,
    parts: parts.map((p) => ({
      partNumber: p.partNumber,
      etag: p.etag,
      sizeBytes: p.sizeBytes.toString(),
      uploadedAt: p.uploadedAt,
    })),
  });
};

export const abortMultipart = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const params = validateParams(uploadIdParamsSchema, req);

  // Aborting deletes staged parts and writes nothing, so it takes the delete
  // grant and goes on in a retired bucket.
  const bucket = await getAccessibleBucket(auth, params.name, "delete");
  const upload = await db.multipartUploads.getAny(params.uploadId);
  assertUploadInBucket(upload, bucket);
  validateMultipartOwnership(auth, upload.createdBy);

  if (upload.completedAt || upload.abortedAt) {
    throw new BadRequestError(
      "upload_not_active",
      "Upload is not in an active state"
    );
  }

  // Mark the row aborted FIRST so concurrent part PUTs / completes start
  // failing `getActive`, then drop the staged dir and the part rows. If the
  // dir cleanup fails the multipart-sweep worker retries it — the part rows
  // are the signal it uses to know cleanup hasn't completed.
  await db.$transaction(async (tx) => {
    if (!(await db.multipartUploads.markAborted(params.uploadId, tx))) {
      throw new BadRequestError(
        "upload_not_active",
        "Upload is not in an active state"
      );
    }

    await logAuditTx(tx, {
      auth,
      organizationId: bucket.organizationId ?? undefined,
      action: "DELETE",
      entityType: "multipartUpload",
      entityId: upload.id,
      entityName: upload.objectKey,
      metadata: {
        bucketName: bucket.name,
        objectKey: upload.objectKey,
      },
    });

    if (bucket.organizationId) {
      await emitTx(tx, {
        eventType: "file-service.multipart.aborted",
        organizationId: bucket.organizationId,
        entityType: "multipartUpload",
        entityId: upload.id,
        data: {
          bucketName: bucket.name,
          objectKey: upload.objectKey,
          reason: "aborted",
        },
      });
    }
  });
  await removeMultipartDir(params.uploadId);
  await db.multipartUploads.deleteParts(params.uploadId);

  setAccessLog(res, {
    bucketId: upload.bucketId,
    operation: "ABORT_MULTIPART",
  });

  res.status(204).send();
};

export const completeMultipart = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const params = validateParams(uploadIdParamsSchema, req);
  const body = validateBody(completeBodySchema, req);
  const idempotencyKey = requireIdempotencyKey(req.header("Idempotency-Key"));

  const bucket = await getAccessibleBucket(auth, params.name, "write");
  // Use `getAny` (not `getActive`) so that a replay of an already-completed
  // upload still passes the ownership check and reaches `withIdempotency`,
  // which returns the cached response. Using `getActive` would 404 the
  // replay before idempotency had a chance to handle it.
  const upload = await db.multipartUploads.getAny(params.uploadId);
  assertUploadInBucket(upload, bucket);
  validateMultipartOwnership(auth, upload.createdBy);

  // Sort once — the request hash is order-independent because we canonicalise
  // it here, but the rest of the handler relies on parts being in ascending
  // order (concat order, min-size-on-all-but-last check).
  const ordered = [...body.parts].sort((a, b) => a.partNumber - b.partNumber);

  // Idempotency requestHash is derived from (uploadId, ordered parts list).
  // Parts are staged server-side and their etags are content-bound, so any
  // different combination yields a different hash — letting us detect "same
  // key reused with a different request" and replay correctly even after the
  // upload row has been finalised.
  const requestHash = crypto
    .createHash("sha256")
    .update(params.uploadId)
    .update("\0")
    .update(canonicalJson(ordered.map((p) => ({ e: p.etag, n: p.partNumber }))))
    .digest("hex");

  // Scope by user + uploadId (uploadId is globally unique, so adding bucketId
  // is redundant). Different users picking the same key never share a replay
  // cache.
  const completeScope = (userId: string) =>
    `user:${userId}:multipart-complete:${params.uploadId}`;

  // One complete of an upload runs at a time, whatever its idempotency key:
  // the claim is renewed for as long as assembly takes and released only
  // once the result is stored, so a retry gets 409 while it runs and the
  // stored result afterwards.
  const idem = await withExclusiveClaim(
    `file-service:multipart-complete:${params.uploadId}`,
    () =>
      new ConflictError(
        "This multipart upload is already being completed; retry shortly",
        "multipart_complete_in_progress"
      ),
    () =>
      withIdempotency(
        {
          scope: completeScope(auth.userId),
          key: idempotencyKey,
          requestHash,
          userId: auth.userId,
        },
        () =>
          runComplete(
            res,
            auth,
            bucket,
            params.uploadId,
            ordered,
            requestHash,
            [completeScope(upload.createdBy), completeScope(auth.userId)]
          )
      )
  );

  if (idem.replayed) res.setHeader("Idempotency-Replay", "true");
  if (idem.body.etag) res.setHeader("ETag", `"${idem.body.etag}"`);
  res.status(idem.status).json(idem.body);
};

/** Assembles the staged parts into the object, unless already done. */
const runComplete = async (
  res: Response,
  auth: ReturnType<typeof validateUser>,
  bucket: Awaited<ReturnType<typeof getAccessibleBucket>>,
  uploadId: string,
  ordered: Array<{ partNumber: number; etag: string }>,
  requestHash: string,
  completeScopes: string[]
): Promise<{ status: number; body: ReturnType<typeof serializeObject> }> => {
  const params = { uploadId };
  // Completed already under another idempotency key: the same parts get
  // that completion's result.
  const finished = await db.multipartUploads.getAny(params.uploadId);
  if (finished.completedAt) {
    const stored = await findStoredResponse<ReturnType<typeof serializeObject>>(
      completeScopes,
      requestHash
    );
    if (stored) return stored;
  }
  // Re-read inside the handler to ensure the upload is still active.
  // A replay of an already-completed upload short-circuits before this
  // runs (handled by withIdempotency); a different parts list after
  // completion is refused here.
  const activeUpload = await db.multipartUploads.getActive(params.uploadId);
  const stagingDek = db.multipartUploads.unwrapStagingDek(activeUpload);
  const staged = await db.multipartUploads.listParts(params.uploadId);
  const stagedByNumber = new Map(staged.map((p) => [p.partNumber, p]));

  // Validate the request matches what was uploaded.
  for (const submitted of ordered) {
    const stagedPart = stagedByNumber.get(submitted.partNumber);
    if (!stagedPart) {
      throw new BadRequestError(
        "part_not_found",
        `Part ${submitted.partNumber} was not uploaded`
      );
    }
    if (stagedPart.etag !== submitted.etag) {
      throw new BadRequestError(
        "part_etag_mismatch",
        `Part ${submitted.partNumber} ETag mismatch`
      );
    }
  }

  // S3-style minimum-part-size enforcement on all but the last. The last
  // part is allowed to be smaller because it can be a "tail" remainder.
  const minSize = BigInt(env.FILE_SERVICE_MIN_PART_SIZE_MB * 1024 * 1024);
  for (let i = 0; i < ordered.length - 1; i++) {
    const part = stagedByNumber.get(ordered[i].partNumber)!;
    if (part.sizeBytes < minSize) {
      throw new BadRequestError(
        "part_too_small",
        `Part ${ordered[i].partNumber} is smaller than the minimum part size`
      );
    }
  }

  // Sum up plaintext bytes for a fail-fast quota pre-check. The
  // authoritative reservation still happens inside `upsertWithBlob`'s
  // transaction below — this is purely so a near-quota caller fails
  // before we burn local disk on the concat + re-encrypt.
  let claimedSize = 0n;
  for (const p of ordered) {
    claimedSize += stagedByNumber.get(p.partNumber)!.sizeBytes;
  }
  if (
    activeUpload.expectedSize !== null &&
    claimedSize !== activeUpload.expectedSize
  ) {
    throw new BadRequestError(
      "size_mismatch",
      `The parts total ${claimedSize} bytes; the upload was initiated with expectedSize ${activeUpload.expectedSize}`
    );
  }
  assertMultipartFits(activeUpload, bucket, claimedSize);

  // Stream concatenation through SHA-256 hashing AND encryption to a
  // single temp file. The final blob hash (plaintext SHA-256) becomes the
  // content blob id. The final object ETag follows the S3 multipart
  // convention: md5(concat(binary_md5_of_each_part))-{partCount}
  const plaintextHasher = crypto.createHash("sha256");
  let plaintextSize = 0;
  // The head of the content, for the same file-type check an upload gets.
  const sniffChunks: Buffer[] = [];
  let sniffBytes = 0;

  const plaintextMeter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      plaintextSize += chunk.length;
      plaintextHasher.update(chunk);
      if (sniffBytes < MIME_SNIFF_BYTES) {
        const slice = chunk.subarray(0, MIME_SNIFF_BYTES - sniffBytes);
        sniffChunks.push(Buffer.from(slice));
        sniffBytes += slice.length;
      }
      cb(null, chunk);
    },
  });

  const { stream: encryptStream, finalize } = createEncryptStream();
  const tempPath = path.join(
    env.FILE_SERVICE_TEMP_PATH,
    `mp-complete-${crypto.randomBytes(8).toString("hex")}`
  );
  await fs.mkdir(env.FILE_SERVICE_TEMP_PATH, { recursive: true });

  // Each staged part is encrypted on disk under the upload's staging DEK.
  // Decrypt as we concat so the plaintextMeter sees real bytes for hashing
  // + size accounting, then re-encrypt the whole concatenation under the
  // final blob DEK.
  const concatSource = async function* () {
    for (const p of ordered) {
      const part = stagedByNumber.get(p.partNumber)!;
      yield* openMultipartPartStream(part.fsPath, stagingDek);
    }
  };

  try {
    await pipeline(
      Readable.from(concatSource()),
      plaintextMeter,
      encryptStream,
      createWriteStream(tempPath)
    );
    await validateMimeType({
      buffer: Buffer.concat(sniffChunks),
      mimetype: activeUpload.contentType,
    });
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }

  // S3-style combined ETag: md5(concat(binary_md5_of_each_part))-N.
  const combinedEtagHasher = crypto.createHash("md5");
  for (const p of ordered) {
    const part = stagedByNumber.get(p.partNumber)!;
    combinedEtagHasher.update(Buffer.from(part.etag, "hex"));
  }

  const hash = plaintextHasher.digest("hex");
  const etag = `${combinedEtagHasher.digest("hex")}-${ordered.length}`;
  const targetPath = getBlobPath(hash);
  const keyMaterial = finalize(hash);

  let result;
  try {
    // Wrap upsertWithBlob (which finalises multipart row + writes object
    // version) and the audit/webhook outbox publish in one transaction so
    // they commit atomically. The heavy concat + encrypt already finished
    // above.
    result = await db.$transaction(async (tx) => {
      const upsert = await db.objects.upsertWithBlob(
        {
          bucketId: activeUpload.bucketId,
          objectKey: activeUpload.objectKey,
          contentType: activeUpload.contentType,
          sizeBytes: BigInt(plaintextSize),
          contentBlobHash: hash,
          metadata: (activeUpload.metadata as never) ?? undefined,
          tags: activeUpload.tags,
          etag,
          createdBy: activeUpload.createdBy,
          stagedPath: tempPath,
          // Finalize the multipart upload row inside the same transaction
          // so completion is atomic with the object write.
          markMultipartCompleted: { uploadId: params.uploadId },
        },
        targetPath,
        keyMaterial,
        tx
      );

      await logAuditTx(tx, {
        auth,
        organizationId: bucket.organizationId ?? undefined,
        action: "CREATE",
        entityType: "multipartUpload",
        entityId: activeUpload.id,
        entityName: activeUpload.objectKey,
        metadata: {
          bucketName: bucket.name,
          objectKey: activeUpload.objectKey,
          contentType: activeUpload.contentType,
          sizeBytes: plaintextSize.toString(),
          etag,
          completedObjectId: upsert.object.id,
        },
      });

      if (bucket.organizationId) {
        await emitTx(tx, {
          eventType: "file-service.multipart.completed",
          organizationId: bucket.organizationId,
          entityType: "multipartUpload",
          entityId: activeUpload.id,
          data: {
            bucketName: bucket.name,
            objectKey: activeUpload.objectKey,
            contentType: activeUpload.contentType,
            sizeBytes: plaintextSize.toString(),
            etag,
            objectId: upsert.object.id,
          },
        });
      }

      await emitObjectWrittenTx(tx, bucket, upsert, "multipart");

      return upsert;
    });
  } catch (err) {
    await db.contentBlobs.releaseStaged({
      hash,
      fsPath: targetPath,
      stagedPath: tempPath,
    });
    throw err;
  }

  // Remove staged part files after the committing tx. If this fails the
  // multipart-sweep backstop cleans the dir — see `multipartSweep.ts`.
  // Part rows are dropped only after dir removal succeeds so that, on
  // failure, the sweep's `parts: { some: {} }` filter still picks the
  // upload up for retry.
  await removeMultipartDir(params.uploadId);
  await db.multipartUploads.deleteParts(params.uploadId);

  setAccessLog(res, {
    bucketId: activeUpload.bucketId,
    objectId: result.object.id,
    operation: "COMPLETE_MULTIPART",
  });

  queueObjectWriteFollowUps(
    bucket,
    result.object.id,
    activeUpload.contentType,
    result.releasedBlobHashes
  );

  return {
    status: result.type === "updated" ? 200 : 201,
    body: serializeObject(result.object),
  };
};
