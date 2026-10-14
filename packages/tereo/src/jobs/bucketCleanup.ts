import { BUCKET_CLEANUP_QUEUE, getBucketCleanupQueue } from "./queues.js";
import { enqueueOrphanBlobCleanup } from "./orphanBlobCleanup.js";
import { TrackedWorker } from "./workerRegistry.js";
import { getRedisClient } from "../utils/redis.js";
import { logger } from "../utils/logger.js";
import db from "../utils/db/index.js";
import { Job, Worker } from "bullmq";
import {
  createTimeBoxedLoop,
  isShuttingDown,
  scheduleContinuation,
} from "./jobUtils.js";

const BATCH_SIZE = 500;
// How long to wait before retrying versions another writer holds locked.
const CONTENDED_RETRY_MS = 5_000;

let worker: Worker | null = null;

export interface BucketCleanupJobData {
  bucketId: number;
  deletedBy: string;
  continuation?: number;
}

/**
 * Enqueue a bucket-cleanup job. Called immediately after `softDeleteBucket`
 * flips the deleted_at fence. Deduped by bucketId so two concurrent DELETE
 * HTTP calls collapse onto a single cleanup run.
 */
export async function enqueueBucketCleanup(
  bucketId: number,
  deletedBy: string
): Promise<void> {
  await getBucketCleanupQueue().add(
    "bucket-cleanup",
    { bucketId, deletedBy, continuation: 0 } satisfies BucketCleanupJobData,
    { jobId: `bucket-cleanup__${bucketId}` }
  );
}

/**
 * Enqueue orphan cleanup for the hashes a batch freed. Non-fatal if Redis
 * hiccups; the hourly orphan-blob-backstop is the safety net.
 */
async function enqueueFreed(hashes: string[]): Promise<void> {
  for (const hash of hashes) {
    try {
      await enqueueOrphanBlobCleanup(hash);
    } catch (err) {
      logger.warn(
        {
          hash,
          err,
        },
        "bucket-cleanup orphan enqueue failed"
      );
    }
  }
}

/**
 * Worker: release bucket blob refs in time-boxed batches, enqueueing orphan
 * cleanup for each batch's freed hashes as it commits (the grace period
 * protects them until then). Uses `FOR UPDATE SKIP LOCKED` inside
 * `releaseBucketBlobRefsBatch` so multiple concurrent bucket-cleanup jobs (or
 * lifecycle sweeps) don't deadlock; versions it skips are retried by a
 * delayed continuation.
 */
async function processBucketCleanup(
  job: Job<BucketCleanupJobData>
): Promise<void> {
  if (isShuttingDown()) {
    await reenqueue(job);
    return;
  }

  const { bucketId, deletedBy } = job.data;
  let freedCount = 0;
  let contended = false;

  const result = await createTimeBoxedLoop<null>({
    job,
    progressMeta: { bucketId },
    tick: async () => {
      const { processed, freedHashes, hasMore } =
        await db.objects.releaseBucketBlobRefsBatch(
          bucketId,
          deletedBy,
          BATCH_SIZE
        );
      freedCount += freedHashes.length;
      await enqueueFreed(freedHashes);
      if (hasMore && processed < BATCH_SIZE) {
        // The rest are locked by another writer — come back rather than spin.
        contended = true;
        return { hasMore: false, processed };
      }
      return { hasMore, processed };
    },
  });

  if (!result.completed || contended) {
    await reenqueue(job, contended ? CONTENDED_RETRY_MS : 0);
    logger.info(
      {
        bucketId,
        processed: result.totalProcessed,
        freedHashes: freedCount,
        contended,
      },
      "Bucket cleanup tick yielded"
    );
    return;
  }

  logger.info(
    {
      bucketId,
      totalProcessed: result.totalProcessed,
      freedHashes: freedCount,
    },
    "Bucket cleanup complete"
  );
}

async function reenqueue(
  job: Job<BucketCleanupJobData>,
  delayMs = 0
): Promise<void> {
  const queue = getBucketCleanupQueue();
  const continuation = (job.data.continuation ?? 0) + 1;
  await scheduleContinuation(
    queue,
    "bucket-cleanup",
    {
      bucketId: job.data.bucketId,
      deletedBy: job.data.deletedBy,
      continuation,
    } satisfies BucketCleanupJobData,
    {
      jobId: `bucket-cleanup__${job.data.bucketId}__c${continuation}`,
      delayMs,
    }
  );
}

export async function startBucketCleanup(): Promise<void> {
  worker = new TrackedWorker<BucketCleanupJobData>(
    BUCKET_CLEANUP_QUEUE,
    async (job) => {
      await processBucketCleanup(job);
    },
    // Parallelism across buckets, but bounded so we don't saturate pg during
    // a burst of bucket deletes.
    { connection: getRedisClient().duplicate(), concurrency: 2 }
  );

  worker.on("failed", (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        bucketId: job?.data?.bucketId,
        err,
      },
      "Bucket cleanup failed"
    );
  });

  logger.info("Bucket cleanup worker started");
}

export async function stopBucketCleanup(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

export { processBucketCleanup };
