import type { EncryptedBlobKeyMaterial } from "./encryption.js";
import { openBlobStream, saveBlobBuffer } from "./storage.js";
import { logger } from "./logger.js";
import db from "./db/index.js";
import sharp from "sharp";

export type ThumbnailSize = "thumb" | "small" | "medium";

const SIZE_PX: Record<ThumbnailSize, number> = {
  thumb: 128,
  small: 512,
  medium: 1024,
};

const THUMBNAIL_CONTENT_TYPE = "image/webp";

/**
 * Decoding bounds for untrusted images. A small, highly compressed file can
 * declare an enormous raster; sharp's own default admits ~268 megapixels.
 */
export const MAX_THUMBNAIL_INPUT_PIXELS = 50_000_000;

const DECODE_OPTIONS = {
  limitInputPixels: MAX_THUMBNAIL_INPUT_PIXELS,
  sequentialRead: true,
} as const;

// Each image is decoded a few times and never again, so libvips' operation
// cache only holds memory.
sharp.cache(false);

/**
 * Whether a stored content type gets thumbnails. SVG is left out: rasterising
 * it runs an XML parser and renderer over untrusted input.
 */
export const isThumbnailSource = (contentType: string): boolean =>
  contentType.startsWith("image/") && !contentType.startsWith("image/svg");

export interface GenerateThumbnailsInput {
  parentObjectId: string;
  bucketId: number;
  /** Hash of the parent's content blob — needed both as the on-disk lookup
   * key and as AAD for unwrapping its DEK. */
  blobHash: string;
  blobMeta: {
    fsPath: string;
    keyMaterial: EncryptedBlobKeyMaterial;
  };
  createdBy: string;
}

/**
 * Generate 3 thumbnail sizes for an image and store each as its own Object +
 * ObjectVersion pointing at a ContentBlob, linked back to the parent via
 * `thumbnailFor`. Best-effort — failures are logged but don't throw. SVG and
 * images over MAX_THUMBNAIL_INPUT_PIXELS get none.
 *
 * This is an internal helper driven by the `thumbnail-generation` BullMQ
 * worker. Callers at the HTTP layer should go through
 * `enqueueThumbnailGeneration` in `jobs/thumbnailGeneration.ts` rather than
 * invoking this directly so the expensive sharp resizes + re-encrypt writes
 * happen off the request path.
 */
export async function generateThumbnails(
  input: GenerateThumbnailsInput
): Promise<void> {
  // The stored content type is the uploader's word; the decoder's is not.
  let probe: sharp.Metadata;
  try {
    const source = openBlobStream(input.blobMeta, input.blobHash);
    const inspector = sharp(DECODE_OPTIONS);
    source.once("error", (err) => inspector.destroy(err));
    try {
      probe = await source.pipe(inspector).metadata();
    } finally {
      source.destroy();
    }
  } catch (err) {
    logger.warn(
      { parentObjectId: input.parentObjectId, err },
      "Thumbnail generation skipped: image could not be read"
    );
    return;
  }
  const pixels = (probe.width ?? 0) * (probe.height ?? 0);
  if (probe.format === "svg" || pixels > MAX_THUMBNAIL_INPUT_PIXELS) {
    logger.info(
      {
        parentObjectId: input.parentObjectId,
        format: probe.format,
        width: probe.width,
        height: probe.height,
      },
      "Thumbnail generation skipped: unsupported or oversized image"
    );
    return;
  }

  for (const [size, px] of Object.entries(SIZE_PX) as [
    ThumbnailSize,
    number,
  ][]) {
    try {
      // Stream the decrypting blob source directly into sharp's transformer
      // rather than buffering the whole plaintext in memory. Sharp only holds
      // the decoded raster it needs to resize, so peak memory is O(output px),
      // not O(source bytes). Opening a fresh stream per size is cheap — the
      // filesystem page cache absorbs the repeat reads.
      const source = openBlobStream(input.blobMeta, input.blobHash);
      const transformer = sharp(DECODE_OPTIONS)
        .rotate()
        .resize(px, px, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 });
      source.once("error", (err) => transformer.destroy(err));
      let thumb: Buffer;
      try {
        thumb = await source.pipe(transformer).toBuffer();
      } finally {
        // `.pipe` leaves the source open when sharp fails.
        source.destroy();
      }

      const saved = await saveBlobBuffer(thumb);
      // Keyed by the parent's id, not its key, so a rename leaves no
      // thumbnail behind to collide with the next object under the old key.
      const thumbKey = `.thumbnails/${input.parentObjectId}/${size}`;

      let stored: boolean;
      try {
        stored = await db.$transaction(async (tx) => {
          // The parent's row first, as a delete or overwrite takes it: one
          // deleted or written again since the job read it gets no thumbnails
          // (a delete drops the parent's thumbnails under this lock).
          const parent = await tx.$queryRaw<{ id: string }[]>`
            SELECT o."id"
            FROM "files"."objects" o
            WHERE o."id" = ${input.parentObjectId}::uuid
              AND o."deleted_at" IS NULL
              AND EXISTS (
                SELECT 1 FROM "files"."object_versions" ov
                WHERE ov."object_id" = o."id"
                  AND ov."is_current" = true
                  AND ov."deleted_at" IS NULL
                  AND ov."content_blob_hash" = ${input.blobHash}
              )
            FOR SHARE OF o
          `;
          if (parent.length === 0) return false;

          // Find the existing thumbnail Object (if any) for this parent + size.
          const existing = await db.objects.findThumbnailByParent(
            input.bucketId,
            input.parentObjectId,
            size,
            tx
          );
          const prior = existing?.versions[0];

          // The prior blob is locked around the attach in hash order.
          const released = prior?.contentBlobHash
            ? [prior.contentBlobHash]
            : [];
          await db.contentBlobs.lockInOrder(
            released.filter((hash) => hash < saved.hash),
            tx
          );
          await db.contentBlobs.attach(
            {
              hash: saved.hash,
              sizeBytes: BigInt(saved.sizeBytes),
              fsPath: saved.fsPath,
              wrappedDek: saved.keyMaterial.wrappedDek,
              iv: saved.keyMaterial.iv,
              masterKeyVersion: saved.keyMaterial.masterKeyVersion,
              stagedPath: saved.stagedPath,
            },
            tx
          );
          await db.contentBlobs.lockInOrder(
            released.filter((hash) => hash > saved.hash),
            tx
          );

          if (existing) {
            if (prior?.contentBlobHash) {
              await db.contentBlobs.decRef(prior.contentBlobHash, tx);
            }
            if (prior) {
              await db.objectVersions.hardDelete(prior.id, tx);
            }
            await db.contentBlobs.incRef(saved.hash, tx);
            await db.objectVersions.create(
              {
                objectId: existing.id,
                contentBlobHash: saved.hash,
                etag: saved.etag,
                contentType: THUMBNAIL_CONTENT_TYPE,
                createdBy: input.createdBy,
                isCurrent: true,
              },
              tx
            );
            await db.objects.touch(existing.id, tx);
          } else {
            const created = await db.objects.createIdentity(
              {
                bucketId: input.bucketId,
                objectKey: thumbKey,
                createdBy: input.createdBy,
                thumbnailFor: input.parentObjectId,
                thumbnailSize: size,
              },
              tx
            );
            await db.contentBlobs.incRef(saved.hash, tx);
            await db.objectVersions.create(
              {
                objectId: created.id,
                contentBlobHash: saved.hash,
                etag: saved.etag,
                contentType: THUMBNAIL_CONTENT_TYPE,
                createdBy: input.createdBy,
                isCurrent: true,
              },
              tx
            );
          }
          return true;
        });
      } catch (txErr) {
        await db.contentBlobs.releaseStaged(saved).catch(() => {});
        throw txErr;
      }
      if (!stored) {
        await db.contentBlobs.releaseStaged(saved).catch(() => {});
        logger.info(
          { parentObjectId: input.parentObjectId },
          "Thumbnail job: parent deleted or replaced; skipping"
        );
        return;
      }
    } catch (err) {
      logger.warn(
        {
          parentObjectId: input.parentObjectId,
          size,
          err,
        },
        "Thumbnail generation failed for size"
      );
    }
  }
}
