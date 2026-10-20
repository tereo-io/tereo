import { BUCKET_CLEANUP_QUEUE, getBucketCleanupQueue } from "./queues.js";
import { enqueueOrphanBlobCleanup } from "./orphanBlobCleanup.js";
import { SYSTEM_USER_ID } from "../definitions/index.js";
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
// Each run checks every deleted bucket for live refs, so not hourly.
const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Leaves a just-deleted bucket to the cleanup its DELETE enqueued.
const RECONCILE_MIN_AGE_SECONDS = 60 * 60;
const RECONCILE_BATCH = 100;
const RECONCILE_JOB = "bucket-cleanup-reconcile";

let worker: Worker | null = null;

export interface BucketCleanupJobData {
  bucketId: number;
  deletedBy: string;
  continuation?: number;
  /**
   * Set on a reconciler's run: its job ids are its own, as the original
   * run's (`bucket-cleanup__<id>`, `…__c<n>`) may still be retained.
   */
  runId?: string;
}

const jobIdOf = (data: BucketCleanupJobData) =>
  [
    `bucket-cleanup__${data.bucketId}`,
    ...(data.runId ? [data.runId] : []),
    ...(data.continuation ? [`c${data.continuation}`] : []),
  ].join("__");

/**
 * Enqueue a bucket-cleanup job. Called immediately after `softDeleteBucket`
 * flips the deleted_at fence. Deduped by bucketId so two concurrent DELETE
 * HTTP calls collapse onto a single cleanup run.
 */
export async function enqueueBucketCleanup(
  bucketId: number,
  deletedBy: string
): Promise<void> {
  const data: BucketCleanupJobData = { bucketId, deletedBy, continuation: 0 };
  await getBucketCleanupQueue().add("bucket-cleanup", data, {
    jobId: jobIdOf(data),
  });
}

/**
 * Give every deleted bucket that still holds blob refs a cleanup run: its
 * DELETE's enqueue may have failed, or its run failed past its retries. The
 * orphan backstop can't stand in, as those blobs' ref counts are not 0.
 */
async function processBucketCleanupReconcile(): Promise<number> {
  const runId = `r${Date.now()}`;
  const queue = getBucketCleanupQueue();
  let enqueued = 0;
  let afterId = 0;
  for (;;) {
    if (isShuttingDown()) break;
    const buckets = await db.buckets.listDeletedHoldingRefs(
      RECONCILE_MIN_AGE_SECONDS,
      RECONCILE_BATCH,
      afterId
    );
    for (const { id, deletedBy } of buckets) {
      const data: BucketCleanupJobData = {
        bucketId: id,
        deletedBy: deletedBy ?? SYSTEM_USER_ID,
        continuation: 0,
        runId,
      };
      try {
        await queue.add("bucket-cleanup", data, { jobId: jobIdOf(data) });
        enqueued++;
      } catch (err) {
        logger.warn(
          { bucketId: id, err },
          "bucket-cleanup reconcile enqueue failed"
        );
      }
    }
    if (buckets.length < RECONCILE_BATCH) break;
    afterId = buckets[buckets.length - 1].id;
  }
  if (enqueued > 0) {
    logger.info({ enqueued }, "Bucket cleanup reconciler enqueued cleanups");
  }
  return enqueued;
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
  const data: BucketCleanupJobData = {
    bucketId: job.data.bucketId,
    deletedBy: job.data.deletedBy,
    continuation: (job.data.continuation ?? 0) + 1,
    ...(job.data.runId ? { runId: job.data.runId } : {}),
  };
  await scheduleContinuation(queue, "bucket-cleanup", data, {
    jobId: jobIdOf(data),
    delayMs,
  });
}

export async function startBucketCleanup(): Promise<void> {
  worker = new TrackedWorker<BucketCleanupJobData>(
    BUCKET_CLEANUP_QUEUE,
    async (job) => {
      if (job.name === RECONCILE_JOB) {
        if (!isShuttingDown()) await processBucketCleanupReconcile();
        return;
      }
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

  await getBucketCleanupQueue().upsertJobScheduler(
    `${RECONCILE_JOB}-scheduler`,
    { every: RECONCILE_INTERVAL_MS },
    { name: RECONCILE_JOB }
  );
  logger.info(
    { reconcileIntervalMs: RECONCILE_INTERVAL_MS },
    "Bucket cleanup worker started"
  );
}

export async function stopBucketCleanup(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

export { processBucketCleanup, processBucketCleanupReconcile };
