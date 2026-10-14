import { Queue } from "bullmq";
import {
  createQueue,
  REMOVAL_POLICIES,
  RETRY_POLICIES,
} from "../utils/bullmq.js";

// --- Single-worker queues --------------------------------------------------
// These jobs are inherently small / bounded and don't benefit from fan-out:
// - multipart-sweep: bounded per-run (at most N expired uploads)
// - orphan-blob-cleanup: one job per hash, seconds
// - orphan-blob-backstop: enqueues small cleanup jobs
// - thumbnail-generation: one job per object, seconds
export const MULTIPART_SWEEP_QUEUE = "file-service-multipart-sweep";
export const ORPHAN_BLOB_CLEANUP_QUEUE = "file-service-orphan-blob-cleanup";
export const ORPHAN_BLOB_BACKSTOP_QUEUE = "file-service-orphan-blob-backstop";
export const THUMBNAIL_GENERATION_QUEUE = "file-service-thumbnail-generation";
export const IDEMPOTENCY_SWEEP_QUEUE = "file-service-idempotency-sweep";
export const SHARE_SWEEP_QUEUE = "file-service-share-sweep";
export const ARCHIVE_SWEEP_QUEUE = "file-service-archive-sweep";

// --- Fan-out queues ---------------------------------------------------------
// Orchestrators run on a scheduler and enqueue small per-unit jobs.
// Per-unit workers time-box each tick and re-enqueue themselves with a cursor
// when there is more work to do.
export const LIFECYCLE_SWEEP_ORCHESTRATOR_QUEUE =
  "file-service-lifecycle-sweep-orchestrator";
export const LIFECYCLE_SWEEP_POLICY_QUEUE =
  "file-service-lifecycle-sweep-policy";
export const LIFECYCLE_SWEEP_PER_OBJECT_TTL_QUEUE =
  "file-service-lifecycle-sweep-per-object-ttl";

export const DISK_BLOB_RECONCILIATION_ORCHESTRATOR_QUEUE =
  "file-service-disk-blob-reconciliation-orchestrator";
export const DISK_BLOB_RECONCILIATION_SHARD_QUEUE =
  "file-service-disk-blob-reconciliation-shard";

export const BUCKET_CLEANUP_QUEUE = "file-service-bucket-cleanup";

let multipartQueue: Queue | null = null;
let orphanBlobQueue: Queue | null = null;
let orphanBackstopQueue: Queue | null = null;
let thumbnailGenerationQueue: Queue | null = null;
let idempotencySweepQueue: Queue | null = null;
let shareSweepQueue: Queue | null = null;
let archiveSweepQueue: Queue | null = null;

let lifecycleOrchestratorQueue: Queue | null = null;
let lifecyclePolicyQueue: Queue | null = null;
let lifecyclePerObjectTtlQueue: Queue | null = null;

let diskReconOrchestratorQueue: Queue | null = null;
let diskReconShardQueue: Queue | null = null;

let bucketCleanupQueue: Queue | null = null;

const SWEEP_JOB_OPTIONS = {
  ...RETRY_POLICIES.MAINTENANCE,
  ...REMOVAL_POLICIES.DEFAULT,
};

const RECON_JOB_OPTIONS = {
  ...RETRY_POLICIES.MAINTENANCE,
  ...REMOVAL_POLICIES.MAINTENANCE,
  removeOnComplete: 50,
  removeOnFail: 50,
};

export function getMultipartSweepQueue(): Queue {
  if (!multipartQueue) {
    multipartQueue = createQueue(MULTIPART_SWEEP_QUEUE, {
      defaultJobOptions: SWEEP_JOB_OPTIONS,
    });
  }
  return multipartQueue;
}

export function getOrphanBlobCleanupQueue(): Queue {
  if (!orphanBlobQueue) {
    orphanBlobQueue = createQueue(ORPHAN_BLOB_CLEANUP_QUEUE, {
      defaultJobOptions: {
        ...RETRY_POLICIES.TRANSIENT,
        ...REMOVAL_POLICIES.TRANSIENT,
      },
    });
  }
  return orphanBlobQueue;
}

export function getOrphanBlobBackstopQueue(): Queue {
  if (!orphanBackstopQueue) {
    orphanBackstopQueue = createQueue(ORPHAN_BLOB_BACKSTOP_QUEUE, {
      defaultJobOptions: SWEEP_JOB_OPTIONS,
    });
  }
  return orphanBackstopQueue;
}

export function getThumbnailGenerationQueue(): Queue {
  if (!thumbnailGenerationQueue) {
    // Thumbnails are short image-decode work; transient failures resolve
    // fast, so use the SCHEDULED tier (3 attempts, 2s backoff) rather than
    // MAINTENANCE's 60s backoff.
    thumbnailGenerationQueue = createQueue(THUMBNAIL_GENERATION_QUEUE, {
      defaultJobOptions: {
        ...RETRY_POLICIES.SCHEDULED,
        backoff: { type: "exponential", delay: 30_000 },
        ...REMOVAL_POLICIES.DEFAULT,
      },
    });
  }
  return thumbnailGenerationQueue;
}

export function getIdempotencySweepQueue(): Queue {
  if (!idempotencySweepQueue) {
    idempotencySweepQueue = createQueue(IDEMPOTENCY_SWEEP_QUEUE, {
      defaultJobOptions: SWEEP_JOB_OPTIONS,
    });
  }
  return idempotencySweepQueue;
}

export function getShareSweepQueue(): Queue {
  if (!shareSweepQueue) {
    shareSweepQueue = createQueue(SHARE_SWEEP_QUEUE, {
      defaultJobOptions: SWEEP_JOB_OPTIONS,
    });
  }
  return shareSweepQueue;
}

export function getArchiveSweepQueue(): Queue {
  if (!archiveSweepQueue) {
    archiveSweepQueue = createQueue(ARCHIVE_SWEEP_QUEUE, {
      defaultJobOptions: SWEEP_JOB_OPTIONS,
    });
  }
  return archiveSweepQueue;
}

// --- Lifecycle fan-out queues ----------------------------------------------

export function getLifecycleOrchestratorQueue(): Queue {
  if (!lifecycleOrchestratorQueue) {
    lifecycleOrchestratorQueue = createQueue(
      LIFECYCLE_SWEEP_ORCHESTRATOR_QUEUE,
      { defaultJobOptions: SWEEP_JOB_OPTIONS }
    );
  }
  return lifecycleOrchestratorQueue;
}

export function getLifecyclePolicyQueue(): Queue {
  if (!lifecyclePolicyQueue) {
    lifecyclePolicyQueue = createQueue(LIFECYCLE_SWEEP_POLICY_QUEUE, {
      defaultJobOptions: SWEEP_JOB_OPTIONS,
    });
  }
  return lifecyclePolicyQueue;
}

export function getLifecyclePerObjectTtlQueue(): Queue {
  if (!lifecyclePerObjectTtlQueue) {
    lifecyclePerObjectTtlQueue = createQueue(
      LIFECYCLE_SWEEP_PER_OBJECT_TTL_QUEUE,
      { defaultJobOptions: SWEEP_JOB_OPTIONS }
    );
  }
  return lifecyclePerObjectTtlQueue;
}

// --- Disk reconciliation fan-out queues ------------------------------------

export function getDiskReconOrchestratorQueue(): Queue {
  if (!diskReconOrchestratorQueue) {
    diskReconOrchestratorQueue = createQueue(
      DISK_BLOB_RECONCILIATION_ORCHESTRATOR_QUEUE,
      { defaultJobOptions: RECON_JOB_OPTIONS }
    );
  }
  return diskReconOrchestratorQueue;
}

export function getDiskReconShardQueue(): Queue {
  if (!diskReconShardQueue) {
    diskReconShardQueue = createQueue(DISK_BLOB_RECONCILIATION_SHARD_QUEUE, {
      defaultJobOptions: RECON_JOB_OPTIONS,
    });
  }
  return diskReconShardQueue;
}

// --- Bucket cleanup --------------------------------------------------------

export function getBucketCleanupQueue(): Queue {
  if (!bucketCleanupQueue) {
    bucketCleanupQueue = createQueue(BUCKET_CLEANUP_QUEUE, {
      defaultJobOptions: SWEEP_JOB_OPTIONS,
    });
  }
  return bucketCleanupQueue;
}

export async function closeQueues(): Promise<void> {
  const toClose = [
    multipartQueue,
    orphanBlobQueue,
    orphanBackstopQueue,
    thumbnailGenerationQueue,
    idempotencySweepQueue,
    shareSweepQueue,
    archiveSweepQueue,
    lifecycleOrchestratorQueue,
    lifecyclePolicyQueue,
    lifecyclePerObjectTtlQueue,
    diskReconOrchestratorQueue,
    diskReconShardQueue,
    bucketCleanupQueue,
  ];
  multipartQueue = null;
  orphanBlobQueue = null;
  orphanBackstopQueue = null;
  thumbnailGenerationQueue = null;
  idempotencySweepQueue = null;
  shareSweepQueue = null;
  archiveSweepQueue = null;
  lifecycleOrchestratorQueue = null;
  lifecyclePolicyQueue = null;
  lifecyclePerObjectTtlQueue = null;
  diskReconOrchestratorQueue = null;
  diskReconShardQueue = null;
  bucketCleanupQueue = null;
  await Promise.allSettled(
    toClose.filter((q): q is Queue => !!q).map((q) => q.close())
  );
}
