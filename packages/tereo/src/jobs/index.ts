import { startLifecycleSweep, stopLifecycleSweep } from "./lifecycleSweep.js";
import { startMultipartSweep, stopMultipartSweep } from "./multipartSweep.js";
import { startBucketCleanup, stopBucketCleanup } from "./bucketCleanup.js";
import { startArchiveSweep, stopArchiveSweep } from "./archiveSweep.js";
import { startAuthCleanup, stopAuthCleanup } from "./authCleanup.js";
import { markShuttingDown, resetShuttingDown } from "./jobUtils.js";
import { startShareSweep, stopShareSweep } from "./shareSweep.js";
import { logger } from "../utils/logger.js";
import {
  startDiskBlobReconciliation,
  stopDiskBlobReconciliation,
} from "./diskBlobReconciliation.js";
import {
  enqueueThumbnailGeneration as enqueueThumbnailGenerationInternal,
  startThumbnailGeneration,
  stopThumbnailGeneration,
} from "./thumbnailGeneration.js";
import {
  startSsoOnlySessionSweep,
  stopSsoOnlySessionSweep,
} from "./ssoOnlySessionSweep.js";
import {
  startRegistryRetirement,
  stopRegistryRetirement,
} from "./registryRetirement.js";
import {
  startOrphanBlobBackstop,
  stopOrphanBlobBackstop,
} from "./orphanBlobBackstop.js";
import {
  enqueueOrphanBlobCleanup as enqueueOrphanBlobCleanupInternal,
  startOrphanBlobCleanup,
  stopOrphanBlobCleanup,
} from "./orphanBlobCleanup.js";
import {
  startIdempotencySweep,
  stopIdempotencySweep,
} from "./idempotencySweep.js";

let started = false;

export async function startBackgroundJobs(): Promise<void> {
  if (started) return;
  // Clear any flag left over from a prior `stop` in this process (supports
  // in-process tests that start/stop the server repeatedly).
  resetShuttingDown();
  started = true;
  try {
    await startLifecycleSweep();
    await startMultipartSweep();
    await startOrphanBlobCleanup();
    await startOrphanBlobBackstop();
    await startDiskBlobReconciliation();
    await startThumbnailGeneration();
    await startBucketCleanup();
    await startIdempotencySweep();
    await startShareSweep();
    await startArchiveSweep();
    await startRegistryRetirement();
    await startAuthCleanup();
    await startSsoOnlySessionSweep();
  } catch (err) {
    logger.error(
      {
        err,
      },
      "Failed to start background jobs"
    );
    started = false;
    throw err;
  }
}

export async function stopBackgroundJobs(): Promise<void> {
  if (!started) return;
  // Flip the shared shutting-down flag BEFORE closing any workers so
  // long-running per-tick loops notice and bail out cleanly (re-enqueuing
  // their continuation cursor) rather than blocking `worker.close()` past the
  // k8s termination grace period.
  markShuttingDown();
  await Promise.allSettled([
    stopLifecycleSweep(),
    stopMultipartSweep(),
    stopOrphanBlobCleanup(),
    stopOrphanBlobBackstop(),
    stopDiskBlobReconciliation(),
    stopThumbnailGeneration(),
    stopBucketCleanup(),
    stopIdempotencySweep(),
    stopShareSweep(),
    stopArchiveSweep(),
    stopRegistryRetirement(),
    stopAuthCleanup(),
    stopSsoOnlySessionSweep(),
  ]);
  started = false;
}

export const enqueueThumbnailGeneration = enqueueThumbnailGenerationInternal;

/**
 * Fire-and-forget variant used by routes/workers after a state transition.
 * Swallows Redis/enqueue failures so the primary request/workflow succeeds;
 * the hourly `orphan-blob-backstop` is the safety net for anything missed.
 */
export function enqueueOrphanBlobCleanupSafe(hash: string): void {
  enqueueOrphanBlobCleanupInternal(hash).catch((err) => {
    logger.warn(
      {
        hash,
        err,
      },
      "orphan enqueue failed"
    );
  });
}

export { enqueueBucketCleanup } from "./bucketCleanup.js";
