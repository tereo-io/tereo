import { enqueueOrphanBlobCleanupSafe } from "../jobs/index.js";
import { broadcastObjectInvalidate } from "./cacheBroadcast.js";
import { sign as presignSign } from "./presigning.js";
import { saveBlobStream } from "./storage.js";
import type { Prisma } from "./db/prisma.js";
import { NotFoundError } from "./errors.js";
import { logAuditTx } from "./outbox.js";
import { Readable } from "node:stream";
import db from "./db/index.js";
import env from "../env.js";

// Profile photos live in the files store, in a bucket only this code writes.
// Calls go straight to the storage and object layers — the same steps the
// upload / delete-by-id / presign routes take, minus request handling and
// bucket-permission checks (nothing here acts on behalf of a caller's grant).
const BUCKET = "auth-service-user-photos";

const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

const EXTENSION_MAP: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

const PRESIGN_TTL_SECONDS = 3600;

export const isAllowedMimeType = (mimeType: string): boolean =>
  ALLOWED_MIME_TYPES.includes(mimeType);

export const getAllowedMimeTypes = (): string[] => [...ALLOWED_MIME_TYPES];

export const getMaxFileSizeBytes = (): number =>
  env.PROFILE_PHOTO_MAX_SIZE_MB * 1024 * 1024;

const objectKey = (userId: string, mimeType: string): string => {
  const ext = EXTENSION_MAP[mimeType] ?? "bin";
  return `users/${userId}/photo.${ext}`;
};

/**
 * Runs in the transaction that stores or removes a photo, so the profile's
 * reference to it changes with the object.
 */
export type PhotoWrite = (
  tx: Prisma.TransactionClient,
  photoObjectId: string
) => Promise<void>;

/**
 * Lock the user's row and read the photo it points at. Every photo write
 * takes this lock first, so one user's uploads and deletes run one at a time
 * and each sees the photo the last one left.
 */
const lockPhotoOwner = async (
  tx: Prisma.TransactionClient,
  userId: string
): Promise<string | null> => {
  const rows = await tx.$queryRaw<{ photo_object_id: string | null }[]>`
    SELECT "photo_object_id" FROM "auth"."users"
    WHERE "id" = ${userId}::uuid
    FOR UPDATE
  `;
  if (rows.length === 0) throw new NotFoundError("User not found");
  return rows[0].photo_object_id;
};

const removePhotoTx = async (
  tx: Prisma.TransactionClient,
  bucketId: number,
  userId: string,
  photoObjectId: string
) => {
  const result = await db.objects.removeObjectById(
    bucketId,
    photoObjectId,
    userId,
    tx
  );
  await logAuditTx(tx, {
    auth: { userId, email: null },
    action: "DELETE",
    entityType: "object",
    entityId: String(result.id),
    entityName: result.objectKey,
    metadata: { bucketName: BUCKET, objectKey: result.objectKey },
  });
  return result;
};

/**
 * Upload a new photo and return the stored object's stable UUID id. The
 * photo it replaces — under another key when the file type differs — is
 * deleted in the same transaction, so the user is left with exactly one.
 */
export const uploadUserPhoto = async (
  userId: string,
  buffer: Buffer,
  mimeType: string,
  onWrite?: PhotoWrite
): Promise<string> => {
  const key = objectKey(userId, mimeType);
  const bucket = await db.buckets.getByName(BUCKET);
  const saved = await saveBlobStream(Readable.from(buffer));

  let written;
  try {
    written = await db.$transaction(async (tx) => {
      const previousId = await lockPhotoOwner(tx, userId);
      // Both photo objects are locked before the bucket, the order every
      // object write takes them in.
      const previous = previousId
        ? await db.objects.checkByIdForUpdate(bucket.id, previousId, tx)
        : null;
      const result = await db.objects.upsertWithBlob(
        {
          bucketId: bucket.id,
          objectKey: key,
          contentType: mimeType,
          contentBlobHash: saved.hash,
          sizeBytes: BigInt(saved.sizeBytes),
          etag: saved.etag,
          createdBy: userId,
          stagedPath: saved.stagedPath,
        },
        saved.fsPath,
        saved.keyMaterial,
        tx
      );
      await logAuditTx(tx, {
        auth: { userId, email: null },
        action: result.type === "updated" ? "UPDATE" : "CREATE",
        entityType: "object",
        entityId: String(result.object.id),
        entityName: key,
        metadata: { bucketName: BUCKET, objectKey: key, contentType: mimeType },
      });
      const replaced =
        previous && previous.id !== result.object.id
          ? await removePhotoTx(tx, bucket.id, userId, previous.id)
          : null;
      await onWrite?.(tx, result.object.id);
      return {
        id: result.object.id,
        replaced,
        released: result.releasedBlobHashes,
      };
    });
  } catch (err) {
    await db.contentBlobs.releaseStaged(saved);
    throw err;
  }
  for (const hash of [
    ...written.released,
    ...(written.replaced?.releasedBlobHashes ?? []),
  ]) {
    enqueueOrphanBlobCleanupSafe(hash);
  }
  await broadcastObjectInvalidate(BUCKET, key);
  if (written.replaced) {
    await broadcastObjectInvalidate(BUCKET, written.replaced.objectKey);
  }
  return written.id;
};

/**
 * Delete the user's photo. Refused (404) when `photoObjectId` is no longer
 * the photo the user has — a concurrent upload replaced it.
 */
export const deleteUserPhoto = async (
  userId: string,
  photoObjectId: string,
  onWrite?: PhotoWrite
): Promise<void> => {
  const bucket = await db.buckets.getByName(BUCKET);
  const deleted = await db.$transaction(async (tx) => {
    if ((await lockPhotoOwner(tx, userId)) !== photoObjectId) {
      throw new NotFoundError("No profile photo to delete");
    }
    const result = await removePhotoTx(tx, bucket.id, userId, photoObjectId);
    await onWrite?.(tx, photoObjectId);
    return result;
  });
  for (const hash of deleted.releasedBlobHashes) {
    enqueueOrphanBlobCleanupSafe(hash);
  }
  await broadcastObjectInvalidate(BUCKET, deleted.objectKey);
};

/**
 * Mint a presigned read URL for a stored profile photo. This code is the sole
 * writer to the bucket, so the stored id is always live. Not audited: it runs
 * on every userinfo and account read.
 */
export const presignUserPhotoUrl = async (
  photoObjectId: string
): Promise<string> =>
  presignSign({
    bucket: BUCKET,
    id: photoObjectId,
    operation: "read",
    expiresInSeconds: PRESIGN_TTL_SECONDS,
  }).url;
