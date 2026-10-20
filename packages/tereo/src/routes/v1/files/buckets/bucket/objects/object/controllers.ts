import { broadcastObjectInvalidate } from "../../../../../../../utils/cacheBroadcast.js";
import { getReadableBucket } from "../../../../../../../utils/bucketAccess.js";
import { parseContentType } from "../../../../../../../utils/contentType.js";
import { setAccessLog } from "../../../../../../../middleware/accessLog.js";
import { downloadQuerySchema, objectParamsSchema } from "./schemas.js";
import { validateUser } from "../../../../../../../middleware/auth.js";
import { logAuditTx } from "../../../../../../../utils/outbox.js";
import { NextFunction, Request, Response } from "express";
import db from "../../../../../../../utils/db/index.js";
import { emitObjectWrittenTx } from "../events.js";
import { createReadStream } from "fs";
import { createHash } from "crypto";
import {
  canonicalJson,
  hasStoredResult,
  requireIdempotencyKey,
  withIdempotency,
} from "../../../../../../../utils/uploadIdempotency.js";
import {
  validateParams,
  validateQuery,
} from "../../../../../../../utils/validateReq.js";
import {
  discardStagedFile,
  saveBlobStream,
} from "../../../../../../../utils/storage.js";
import {
  BadRequestError,
  NotFoundError,
} from "../../../../../../../utils/errors.js";
import {
  assertObjectKeyNotReserved,
  cleanupMulterTempFile,
  extractTagsFromRequest,
  getBucket,
  handleMetadata,
  parseEtagPreconditions,
  prepareDownload,
  queueObjectWriteFollowUps,
  seesBucketHistory,
  sendBlobBody,
  serializeObject,
  standardizeObjectKey,
  validateMimeType,
} from "../utils.js";

const putObjectScope = (userId: string, bucketId: number) =>
  `user:${userId}:bucket:${bucketId}:put-object`;

/**
 * Runs before the multipart body is read, so a request that would be refused
 * anyway (no Idempotency-Key, bad key, no write access, a declared length the
 * quota has no room for) never has its file staged to disk.
 */
export const authorizeUpload = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const auth = validateUser(req);
  standardizeObjectKey(req);
  const params = validateParams(objectParamsSchema, req);
  const idempotencyKey = requireIdempotencyKey(req.header("Idempotency-Key"));
  const bucket = await getBucket(params.name, auth);
  res.locals.uploadBucket = bucket;
  // After the access check, so a caller without access learns nothing.
  assertObjectKeyNotReserved(params.objectKey);
  const declared = Number(req.headers["content-length"]);
  // A retry of an upload that filled the bucket gets its stored response.
  if (
    Number.isSafeInteger(declared) &&
    declared > 0 &&
    !(await hasStoredResult(
      putObjectScope(auth.userId, bucket.id),
      idempotencyKey
    ))
  ) {
    await db.buckets.assertUploadMayFit(
      bucket.id,
      params.objectKey,
      BigInt(declared)
    );
  }
  next();
};

/**
 * Upload an object to a bucket.
 * PUT /buckets/:name/objects/*objectKey
 */
export const uploadObject = async (req: Request, res: Response) => {
  try {
    await storeUpload(req, res);
  } finally {
    await cleanupMulterTempFile(req.file);
  }
};

const storeUpload = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const params = validateParams(objectParamsSchema, req);
  const idempotencyKey = requireIdempotencyKey(req.header("Idempotency-Key"));
  const bucket = res.locals.uploadBucket as Awaited<
    ReturnType<typeof getBucket>
  >;

  if (!req.file) {
    throw new BadRequestError("file_upload_required", "File upload required");
  }
  const contentType = parseContentType(req.file.mimetype);
  await validateMimeType({ path: req.file.path, mimetype: contentType });

  const metadata = handleMetadata(req);
  const tags = extractTagsFromRequest(req);

  // Checked by `upsertWithBlob` under the object's row lock, after a replay
  // of this idempotency key has had its chance to answer.
  const preconditions = parseEtagPreconditions(req);

  const saved = await saveBlobStream(createReadStream(req.file.path));
  await cleanupMulterTempFile(req.file);

  // Idempotency requestHash binds the bucket, object key, blob content,
  // content type, tags, and metadata. canonicalJson sorts object keys + array elements so retries
  // whose metadata or tag ordering differs still hash identically.
  const requestHash = createHash("sha256")
    .update(String(bucket.id))
    .update("\0")
    .update(params.objectKey)
    .update("\0")
    .update(saved.hash)
    .update("\0")
    .update(contentType)
    .update("\0")
    .update(canonicalJson(metadata ?? null))
    .update("\0")
    .update(canonicalJson(tags ? [...tags].sort() : null))
    .digest("hex");

  // A replay or refusal never reaches the write, which places or drops the
  // staged file; the `finally` below drops it then.
  const idem = await withIdempotency<ReturnType<typeof serializeObject>>(
    {
      scope: putObjectScope(auth.userId, bucket.id),
      key: idempotencyKey,
      requestHash,
      userId: auth.userId,
    },
    async (persist) => {
      let result;
      try {
        // Wrap upsertWithBlob + audit/webhook outbox in a single transaction
        // so the audit/event commit atomically with the new version row. Heavy
        // I/O (saveBlobStream / encryption) already finished above; this
        // transaction only does DB work.
        result = await db.$transaction(async (tx) => {
          const upsert = await db.objects.upsertWithBlob(
            {
              bucketId: bucket.id,
              objectKey: params.objectKey,
              contentType,
              contentBlobHash: saved.hash,
              sizeBytes: BigInt(saved.sizeBytes),
              etag: saved.etag,
              metadata,
              tags,
              createdBy: auth.userId,
              stagedPath: saved.stagedPath,
              preconditions,
            },
            saved.fsPath,
            saved.keyMaterial,
            tx
          );

          const serialized = serializeObject(upsert.object);

          await logAuditTx(tx, {
            auth,
            organizationId: bucket.organizationId ?? undefined,
            action: upsert.type === "updated" ? "UPDATE" : "CREATE",
            entityType: "object",
            entityId: String(upsert.object.id),
            entityName: params.objectKey,
            metadata: {
              bucketName: bucket.name,
              objectKey: serialized.key,
              contentType: serialized.contentType,
              sizeBytes: serialized.sizeBytes,
              etag: serialized.etag,
            },
          });

          await emitObjectWrittenTx(tx, bucket, upsert, "direct");

          await persist(tx, {
            status: upsert.type === "updated" ? 200 : 201,
            body: serialized,
          });

          return { ...upsert, body: serialized };
        });
      } catch (err) {
        await db.contentBlobs.releaseStaged(saved);
        throw err;
      }

      setAccessLog(res, {
        bucketId: bucket.id,
        objectId: result.object.id,
        operation:
          result.type === "updated" ? "UPDATE_OBJECT" : "CREATE_OBJECT",
      });

      queueObjectWriteFollowUps(
        bucket,
        result.object.id,
        contentType,
        result.releasedBlobHashes
      );

      // Upload changed the current version; any cached per-object metadata is
      // now stale. Tell the fleet to drop it.
      await broadcastObjectInvalidate(bucket.name, params.objectKey);

      return {
        status: result.type === "updated" ? 200 : 201,
        body: result.body,
      };
    }
  ).finally(() => discardStagedFile(saved.stagedPath));

  if (idem.replayed) res.setHeader("Idempotency-Replay", "true");
  if (idem.body.etag) res.setHeader("ETag", `"${idem.body.etag}"`);
  res.status(idem.status).json(idem.body);
};

/**
 * What a download by key serves: the current version, the one `?versionId=`
 * names, or a thumbnail of it. A version no longer current is not served to
 * a caller who does not see the bucket's history (`seesBucketHistory`).
 */
const resolveKeyDownload = async (req: Request) => {
  standardizeObjectKey(req);
  const params = validateParams(objectParamsSchema, req);
  const query = validateQuery(downloadQuerySchema, req);

  const bucket = await getReadableBucket(req, params.name);

  const parent = await db.objects.getByKey(bucket.id, params.objectKey);
  let object = parent;

  // None are served while the bucket's autoThumbnails is off, whatever is stored.
  if (query.thumbnail) {
    if (!bucket.autoThumbnails) throw new NotFoundError("Thumbnail not found");
    const thumb = await db.objects.getThumbnail(object.id, query.thumbnail);
    if (!thumb) throw new NotFoundError("Thumbnail not found");
    object = thumb;
  }

  let version = object.versions[0];
  if (!version) throw new NotFoundError("Object has no current version");
  let lastModified = object.updatedAt;

  if (query.versionId) {
    const pinned = await db.objectVersions.getByVersionId(
      object.id,
      query.versionId
    );
    if (!pinned.isCurrent && !(await seesBucketHistory(req, bucket))) {
      throw new NotFoundError("Version not found");
    }
    if (!pinned.contentBlob) {
      throw new NotFoundError(
        "Requested version has no content (delete marker)"
      );
    }
    version = pinned;
    lastModified = pinned.createdAt;
  }

  if (!version.contentBlob || version.isDeleteMarker) {
    throw new NotFoundError("Object has no retrievable content");
  }
  return {
    bucket,
    parent,
    object,
    version,
    contentBlob: version.contentBlob,
    lastModified,
    pinnedVersion: !!query.versionId && !query.thumbnail,
  };
};

/**
 * The headers of a download by key; true when its preconditions ended the
 * response.
 */
const prepareKeyDownload = (
  req: Request,
  res: Response,
  target: Awaited<ReturnType<typeof resolveKeyDownload>>
) => {
  const handled = prepareDownload(req, res, {
    bucket: target.bucket,
    pinnedVersion: target.pinnedVersion,
    objectKey: target.object.objectKey,
    contentType: target.version.contentType,
    etag: target.version.etag ?? "",
    lastModified: target.lastModified,
  });
  // The parent's id: a thumbnail is not addressable by its own.
  res.setHeader("X-Object-Id", target.parent.id);
  return handled;
};

/**
 * Download an object (or a specific version / thumbnail) from a bucket.
 * GET /buckets/:name/objects/*objectKey
 */
export const downloadObject = async (req: Request, res: Response) => {
  const target = await resolveKeyDownload(req);
  if (prepareKeyDownload(req, res, target)) return;

  setAccessLog(res, {
    bucketId: target.bucket.id,
    objectId: target.object.id,
    operation: "DOWNLOAD_OBJECT",
  });

  await sendBlobBody(req, res, target.contentBlob, {
    etag: target.version.etag ?? "",
    lastModified: target.lastModified,
  });
};

/**
 * The headers `GET` would send, without the body.
 * HEAD /buckets/:name/objects/*objectKey
 */
export const getObjectMetadata = async (req: Request, res: Response) => {
  const target = await resolveKeyDownload(req);
  if (prepareKeyDownload(req, res, target)) return;

  setAccessLog(res, {
    bucketId: target.bucket.id,
    objectId: target.object.id,
    operation: "GET_OBJECT_METADATA",
  });

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Length", target.contentBlob.sizeBytes.toString());
  res.status(200).end();
};
