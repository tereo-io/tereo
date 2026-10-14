import { deleteBlobFile } from "../utils/storage.js";
import { TrackedWorker } from "./workerRegistry.js";
import { getRedisClient } from "../utils/redis.js";
import { isShuttingDown } from "./jobUtils.js";
import { logger } from "../utils/logger.js";
import db from "../utils/db/index.js";
import { Worker } from "bullmq";
import env from "../env.js";
import {
  getOrphanBlobCleanupQueue,
  ORPHAN_BLOB_CLEANUP_QUEUE,
} from "./queues.js";

interface OrphanBlobJobData {
  hash: string;
}

let worker: Worker | null = null;

// How long a job that finds its blob orphaned but not claimable waits before
// checking again, at the least.
const RECHECK_DELAY_MS = 60_000;

/**
 * Enqueue an orphan-blob-cleanup job for when the blob's grace period ends.
 * Safe to call outside a transaction — this is fire-and-forget. A no-op when
 * the blob is gone or no longer orphaned.
 *
 * The job id names the orphaning (`orphan__{hash}__{orphanedAt ms}`), so
 * repeated enqueues of one orphaning collapse while a blob orphaned again gets
 * a new job, though the old one's id is still retained. `suffix` adds a job
 * for the same orphaning, for when an earlier one finished without deleting.
 */
export async function enqueueOrphanBlobCleanup(
  hash: string,
  options: { suffix?: string; minDelayMs?: number } = {}
): Promise<void> {
  const blob = await db.contentBlobs.getByHash(hash);
  if (!blob || blob.refCount > 0 || !blob.orphanedAt) return;
  const orphanedAt = blob.orphanedAt.getTime();
  const graceEnds =
    orphanedAt + env.FILE_SERVICE_ORPHAN_BLOB_GRACE_SECONDS * 1000;
  const suffix = options.suffix ? `__${options.suffix}` : "";
  await getOrphanBlobCleanupQueue().add(
    "orphan-blob-cleanup",
    { hash },
    {
      jobId: `orphan__${hash}__${orphanedAt}${suffix}`,
      delay: Math.max(graceEnds - Date.now(), options.minDelayMs ?? 0, 0),
    }
  );
}

async function processOrphanBlobCleanup(hash: string): Promise<void> {
  if (isShuttingDown()) return;
  // Phase 1 (txn): atomically claim the orphan row (SELECT FOR UPDATE) and
  // delete it. We commit the DB intent before touching disk because any
  // concurrent `attach` that was waiting on our row lock will now wake up, see
  // no conflict, and INSERT a fresh row pointing at the same `fs_path`.
  const claimed = await db.$transaction(async (tx) => {
    const row = await db.contentBlobs.claimOrphan(
      hash,
      env.FILE_SERVICE_ORPHAN_BLOB_GRACE_SECONDS,
      tx
    );
    if (!row) return null;
    await db.contentBlobs.deleteByHash(hash, tx);
    return row;
  });
  if (!claimed) {
    // Still in its grace (this job ran early) or row-locked by a writer: while
    // it stays orphaned, check again under a fresh job id.
    await enqueueOrphanBlobCleanup(hash, {
      suffix: `r${Date.now()}`,
      minDelayMs: RECHECK_DELAY_MS,
    });
    return;
  }

  // Phase 2: if an upload re-created a ContentBlob with this hash after Phase
  // 1 committed, the file at `fs_path` is that blob's now. The check and the
  // unlink run under the blob's lock (`lockHash`), which an upload creating
  // the row holds from before it places its file until it commits — so the
  // new row is seen here, or the upload places its file after the unlink.
  await db.$transaction(async (tx) => {
    await db.contentBlobs.lockHash(hash, tx);
    if (await db.contentBlobs.getByHash(hash, tx)) {
      logger.info(
        { hash, fsPath: claimed.fs_path },
        "Orphan blob cleanup aborted — blob was re-uploaded after orphan claim"
      );
      return;
    }
    await deleteBlobFile(claimed.fs_path);
  });
}

export async function startOrphanBlobCleanup(): Promise<void> {
  worker = new TrackedWorker<OrphanBlobJobData>(
    ORPHAN_BLOB_CLEANUP_QUEUE,
    async (job) => {
      await processOrphanBlobCleanup(job.data.hash);
    },
    { connection: getRedisClient().duplicate(), concurrency: 4 }
  );

  worker.on("failed", (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        hash: job?.data?.hash,
        err,
      },
      "Orphan blob cleanup failed"
    );
  });

  logger.info("Orphan blob cleanup worker started");
}

export async function stopOrphanBlobCleanup(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

export { processOrphanBlobCleanup };
