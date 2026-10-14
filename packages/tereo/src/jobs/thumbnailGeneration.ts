import { generateThumbnails, isThumbnailSource } from "../utils/thumbnails.js";
import { TrackedWorker } from "./workerRegistry.js";
import { getRedisClient } from "../utils/redis.js";
import { logger } from "../utils/logger.js";
import db from "../utils/db/index.js";
import { Worker } from "bullmq";
import {
  getThumbnailGenerationQueue,
  THUMBNAIL_GENERATION_QUEUE,
} from "./queues.js";

interface ThumbnailGenerationJobData {
  parentObjectId: string;
  /**
   * Hash of the parent's ContentBlob at enqueue time. Used by the worker as a
   * cancellation fence: if by the time we run, the parent's current version
   * points at a different blob, the object was re-uploaded and a fresh job
   * was already scheduled, so we skip.
   */
  contentBlobHash: string;
}

let worker: Worker | null = null;

/**
 * Schedule thumbnail generation for the given parent object.
 *
 * The worker re-fetches the parent's current ObjectVersion + ContentBlob from
 * the DB at run time — we intentionally do NOT pass blob `fsPath` or encryption
 * key material through Redis. This keeps DEKs out of the queue store.
 *
 * Job IDs name the version (`thumbnails__{parentObjectId}__{versionId}`), not
 * its content: finished jobs are retained, so a hash-keyed id would drop the
 * job for content A uploaded again after B, leaving B's thumbnails.
 */
export async function enqueueThumbnailGeneration(
  parentObjectId: string
): Promise<void> {
  // Look up the current version so we can both key the job on it and give
  // the worker a cancellation fence. If the object doesn't
  // exist or has no current content-bearing version, there's nothing to do.
  const object = await db.objects.get(parentObjectId);
  const current = object.versions[0];
  if (!current || !current.contentBlobHash) {
    return;
  }

  await getThumbnailGenerationQueue().add(
    "thumbnail-generation",
    {
      parentObjectId,
      contentBlobHash: current.contentBlobHash,
    } satisfies ThumbnailGenerationJobData,
    {
      jobId: `thumbnails__${parentObjectId}__${current.id}`,
    }
  );
}

/**
 * Worker implementation. Re-hydrates the parent object's current content blob
 * from the DB, then delegates to the existing thumbnail pipeline. Cleanly
 * no-ops (no throw) when the work is no longer relevant — object deleted,
 * content replaced, not an image, etc.
 */
async function processThumbnailGeneration(
  data: ThumbnailGenerationJobData
): Promise<void> {
  const { parentObjectId, contentBlobHash } = data;

  let object;
  try {
    object = await db.objects.get(parentObjectId);
  } catch {
    // Parent object no longer exists (deleted between enqueue and run).
    logger.info(
      {
        parentObjectId,
      },
      "Thumbnail job: parent object missing; skipping"
    );
    return;
  }

  const current = object.versions[0];
  if (!current || !current.contentBlob || !current.contentBlobHash) {
    logger.info(
      {
        parentObjectId,
      },
      "Thumbnail job: no current content-bearing version; skipping"
    );
    return;
  }

  // Cancellation fence: if the current blob no longer matches what we were
  // enqueued for, the object was re-uploaded and a fresh job has already been
  // (or will be) scheduled for the new hash.
  if (current.contentBlobHash !== contentBlobHash) {
    logger.info(
      {
        parentObjectId,
        enqueuedHash: contentBlobHash,
        currentHash: current.contentBlobHash,
      },
      "Thumbnail job: content changed since enqueue; skipping"
    );
    return;
  }

  const contentType = current.contentType ?? "";
  if (!isThumbnailSource(contentType)) {
    logger.info(
      {
        parentObjectId,
        contentType,
      },
      "Thumbnail job: content-type takes no thumbnails; skipping"
    );
    return;
  }

  await generateThumbnails({
    parentObjectId,
    bucketId: object.bucketId,
    blobHash: current.contentBlobHash,
    blobMeta: {
      fsPath: current.contentBlob.fsPath,
      keyMaterial: {
        wrappedDek: Buffer.from(current.contentBlob.wrappedDek),
        iv: Buffer.from(current.contentBlob.iv),
        masterKeyVersion: current.contentBlob.masterKeyVersion,
      },
    },
    createdBy: current.createdBy,
  });
}

export async function startThumbnailGeneration(): Promise<void> {
  worker = new TrackedWorker<ThumbnailGenerationJobData>(
    THUMBNAIL_GENERATION_QUEUE,
    async (job) => {
      await processThumbnailGeneration(job.data);
    },
    {
      connection: getRedisClient().duplicate(),
      // sharp is CPU-heavy — two concurrent jobs is plenty per node.
      concurrency: 2,
    }
  );

  worker.on("failed", (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        parentObjectId: job?.data?.parentObjectId,
        err,
      },
      "Thumbnail generation failed"
    );
  });

  logger.info("Thumbnail generation worker started");
}

export async function stopThumbnailGeneration(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
