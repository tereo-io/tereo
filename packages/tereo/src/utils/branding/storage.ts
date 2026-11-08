import { enqueueOrphanBlobCleanupSafe } from "../../jobs/index.js";
import { brandingObjectKey, type CheckedImage } from "./images.js";
import { broadcastObjectInvalidate } from "../cacheBroadcast.js";
import { saveBlobStream } from "../storage.js";
import type { Prisma } from "../db/prisma.js";
import { logAuditTx } from "../outbox.js";
import { prisma } from "../db/prisma.js";
import { Readable } from "node:stream";
import db from "../db/index.js";

export const BRANDING_BUCKET = "auth-service-branding";

// Covers uploads not yet saved into a profile and pages already rendered with
// a just-replaced image.
export const BRANDING_IMAGE_GRACE_MS = 24 * 60 * 60 * 1000;

export type StoredImage = { objectId: string; objectKey: string };

export type LiveImage = StoredImage & { sizeBytes: number };

/** A live object holding this content, under whichever extension it was stored. */
export const getLiveImageByHash = async (
  sha256: string,
  tx?: Prisma.TransactionClient
): Promise<LiveImage | null> => {
  const row = await (tx ?? prisma).object.findFirst({
    where: {
      bucket: { name: BRANDING_BUCKET },
      objectKey: { startsWith: `${sha256}.` },
      deletedAt: null,
      thumbnailFor: null,
    },
    select: {
      id: true,
      objectKey: true,
      versions: {
        where: { isCurrent: true, deletedAt: null },
        select: { contentBlob: { select: { sizeBytes: true } } },
        take: 1,
      },
    },
  });
  if (!row) return null;
  return {
    objectId: row.id,
    objectKey: row.objectKey,
    sizeBytes: Number(row.versions[0]?.contentBlob?.sizeBytes ?? 0),
  };
};

/**
 * Reusing an unreferenced image restarts its grace period, so it cannot expire
 * before the caller's profile references it. A null `delete_after` means a
 * profile references it: left alone. Returns false when the object is gone.
 */
const extendExpiryTx = async (
  tx: Prisma.TransactionClient,
  objectId: string
): Promise<boolean> => {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "files"."objects"
    WHERE "id" = ${objectId}::uuid AND "deleted_at" IS NULL
    FOR UPDATE
  `;
  if (rows.length === 0) return false;
  await tx.$executeRaw`
    UPDATE "files"."objects"
    SET "delete_after" = GREATEST("delete_after", ${new Date(Date.now() + BRANDING_IMAGE_GRACE_MS)})
    WHERE "id" = ${objectId}::uuid AND "delete_after" IS NOT NULL
  `;
  return true;
};

/**
 * Store a checked image under its content-addressed key. A live object with
 * that key is reused as is; a new one expires after the grace period unless a
 * profile references it first.
 */
export const storeBrandingImage = async (
  image: CheckedImage,
  actorUserId: string
): Promise<StoredImage> => {
  const key = brandingObjectKey(image);
  const bucket = await db.buckets.getByName(BRANDING_BUCKET);

  const existing = await getLiveImageByHash(image.sha256);
  if (existing?.objectKey === key) {
    const stillLive = await db.$transaction((tx) =>
      extendExpiryTx(tx, existing.objectId)
    );
    if (stillLive) return { objectId: existing.objectId, objectKey: key };
  }

  const saved = await saveBlobStream(Readable.from(image.buffer));
  let written;
  try {
    written = await db.$transaction(async (tx) => {
      // Same lock upsertWithBlob takes: the check below and the write it
      // guards cannot interleave with another store of this key.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`files:key:${bucket.id}:${key}`}, 0))`;
      const live = await tx.object.findFirst({
        where: {
          bucketId: bucket.id,
          objectKey: key,
          deletedAt: null,
          thumbnailFor: null,
        },
        select: { id: true },
      });
      if (live && (await extendExpiryTx(tx, live.id))) {
        return { reused: true as const, id: live.id, released: [] as string[] };
      }
      const result = await db.objects.upsertWithBlob(
        {
          bucketId: bucket.id,
          objectKey: key,
          contentType: image.mime,
          contentBlobHash: saved.hash,
          sizeBytes: BigInt(saved.sizeBytes),
          etag: saved.etag,
          createdBy: actorUserId,
          stagedPath: saved.stagedPath,
          deleteAfter: new Date(Date.now() + BRANDING_IMAGE_GRACE_MS),
        },
        saved.fsPath,
        saved.keyMaterial,
        tx
      );
      await logAuditTx(tx, {
        auth: { userId: actorUserId, email: null },
        action: "CREATE",
        entityType: "object",
        entityId: String(result.object.id),
        entityName: key,
        metadata: {
          bucketName: BRANDING_BUCKET,
          objectKey: key,
          contentType: image.mime,
        },
      });
      return {
        reused: false as const,
        id: result.object.id,
        released: result.releasedBlobHashes,
      };
    });
  } catch (err) {
    await db.contentBlobs.releaseStaged(saved);
    throw err;
  }

  if (written.reused) {
    await db.contentBlobs.releaseStaged(saved);
    return { objectId: written.id, objectKey: key };
  }
  for (const hash of written.released) enqueueOrphanBlobCleanupSafe(hash);
  await broadcastObjectInvalidate(BRANDING_BUCKET, key);
  return { objectId: written.id, objectKey: key };
};
