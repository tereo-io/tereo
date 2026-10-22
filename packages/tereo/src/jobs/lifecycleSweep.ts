import { bucketEventScope, emitTx, logAuditTx } from "../utils/outbox.js";
import { enqueueOrphanBlobCleanup } from "./orphanBlobCleanup.js";
import { SYSTEM_USER_ID } from "../definitions/index.js";
import { TrackedWorker } from "./workerRegistry.js";
import type { Prisma } from "../utils/db/prisma.js";
import { getRedisClient } from "../utils/redis.js";
import { logger } from "../utils/logger.js";
import db from "../utils/db/index.js";
import { Job, Worker } from "bullmq";
import {
  createTimeBoxedLoop,
  isShuttingDown,
  scheduleContinuation,
} from "./jobUtils.js";
import {
  getLifecycleOrchestratorQueue,
  getLifecyclePerObjectTtlQueue,
  getLifecyclePolicyQueue,
  LIFECYCLE_SWEEP_ORCHESTRATOR_QUEUE,
  LIFECYCLE_SWEEP_PER_OBJECT_TTL_QUEUE,
  LIFECYCLE_SWEEP_POLICY_QUEUE,
} from "./queues.js";

/**
 * Best-effort orphan-cleanup enqueue, after the batch commits. A failed one is
 * logged; the hourly orphan backstop reclaims the blob instead.
 */
async function safeEnqueueOrphan(hash: string): Promise<void> {
  try {
    await enqueueOrphanBlobCleanup(hash);
  } catch (err) {
    logger.warn(
      {
        hash,
        err,
      },
      "orphan enqueue failed"
    );
  }
}

type LifecycleStage =
  "expireObjects" | "expireVersions" | "purgeSoftDeleted" | "perObjectTtl";

type LifecycleBucket = {
  id: number;
  name: string;
  organizationId: string | null;
  serviceId: string | null;
};

/**
 * The audit entry and webhook event for one sweep batch, written in the
 * batch's transaction so both commit with the deletes they record. One event
 * per batch caps its payload at BATCH_LIMIT ids, even when a sweep purges
 * millions of objects across many ticks.
 */
async function recordLifecycleBatchTx(
  tx: Prisma.TransactionClient,
  bucket: LifecycleBucket,
  stage: LifecycleStage,
  entityType: "object" | "objectVersion",
  entities: Array<{ id: string; objectKey?: string }>
): Promise<void> {
  await logAuditTx(tx, {
    auth: { userId: SYSTEM_USER_ID, email: null },
    organizationId: bucket.organizationId,
    action: "DELETE",
    entityType: "lifecycleSweep",
    entityId: String(bucket.id),
    entityName: bucket.name,
    metadata: {
      bucketName: bucket.name,
      stage,
      entityType,
      processed: entities.length,
      entities,
    },
  });
  await emitTx(tx, {
    eventType: "file-service.lifecycle.policy.applied",
    ...bucketEventScope(bucket),
    entityType: "bucket",
    entityId: String(bucket.id),
    data: {
      bucketId: bucket.id,
      bucketName: bucket.name,
      stage,
      processed: entities.length,
      entityType,
      entityIds: entities.map((e) => e.id),
      // Written before the orphan-cleanup enqueues, which run after commit,
      // so it can't report their failure (the hourly backstop covers it).
      // Kept, always false, for subscribers that require it.
      pendingCleanup: false,
    },
  });
}

const JOB_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Per-tick batch size. Kept small so each tick stays bounded and the
// `createTimeBoxedLoop` gets a chance to yield at its configured wall-clock.
const BATCH_LIMIT = 100;

let orchestratorWorker: Worker | null = null;
let policyWorker: Worker | null = null;
let perObjectTtlWorker: Worker | null = null;

// --- Cursor types ---------------------------------------------------------

type PolicyCursorKind =
  "expireObjects" | "expireVersions" | "purgeSoftDeleted" | "done";

// UUID cursor. `lastId` is the PK (uuid) of the last row processed; the next
// tick fetches `id > lastId ORDER BY id ASC`. UUID strings compare
// lexicographically in both JS and Postgres, so this is a stable, total order
// — sufficient for cursor pagination even though UUIDs are not temporal.
// `MIN_UUID` ("000…0") seeds the first tick.
interface PolicyCursor {
  kind: PolicyCursorKind;
  lastId: string;
}

interface PerObjectTtlCursor {
  lastId: string;
}

const MIN_UUID = "00000000-0000-0000-0000-000000000000";

interface LifecyclePolicyJobData {
  bucketId: number;
  cursor?: PolicyCursor;
  /** Continuation counter, embedded in jobId so self-reschedules don't dedupe. */
  continuation?: number;
}

interface PerObjectTtlJobData {
  cursor?: PerObjectTtlCursor;
  continuation?: number;
}

function dayStamp(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// --- Per-tick batch workers -----------------------------------------------

/**
 * One tick of the "expire objects past N days" stage. Soft-deletes up to
 * BATCH_LIMIT objects; returns the new cursor + whether more remain.
 */
async function tickExpireObjects(
  bucket: LifecycleBucket,
  days: number,
  afterId: string
): Promise<{ lastId: string; hasMore: boolean; processed: number }> {
  const expired = await db.lifecyclePolicies.findObjectsPastExpiration(
    bucket.id,
    days,
    BATCH_LIMIT,
    afterId
  );
  if (expired.length === 0) {
    return { lastId: afterId, hasMore: false, processed: 0 };
  }
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  let newLastId = afterId;
  for (const obj of expired) if (obj.id > newLastId) newLastId = obj.id;
  const removed = await db.objects.removeExpiredObjects(
    bucket.id,
    expired.map((o) => o.id),
    { lastWrittenBefore: cutoff },
    SYSTEM_USER_ID,
    (tx, objects) =>
      recordLifecycleBatchTx(tx, bucket, "expireObjects", "object", objects)
  );
  for (const r of removed) {
    for (const hash of r.releasedBlobHashes) await safeEnqueueOrphan(hash);
  }
  return {
    lastId: newLastId,
    hasMore: expired.length >= BATCH_LIMIT,
    processed: expired.length,
  };
}

/**
 * One tick of the "expire non-current versions older than N days" stage.
 *
 * In a versioning-enabled bucket, each retained version contributes its
 * blob's `sizeBytes` to `current_usage_bytes` (see `getLiveUsageBytes` doc),
 * so dropping a non-delete-marker version's ref must decrement the counter
 * in the same transaction — otherwise the UI's Total / Historical usage
 * lines stay inflated even after the bytes are reclaimed.
 */
async function tickExpireVersions(
  bucket: LifecycleBucket,
  days: number,
  versioningEnabled: boolean,
  afterId: string
): Promise<{ lastId: string; hasMore: boolean; processed: number }> {
  const expired = await db.lifecyclePolicies.findVersionsPastExpiration(
    bucket.id,
    days,
    BATCH_LIMIT,
    afterId
  );
  if (expired.length === 0) {
    return { lastId: afterId, hasMore: false, processed: 0 };
  }
  let newLastId = afterId;
  for (const v of expired) if (v.id > newLastId) newLastId = v.id;
  // The batch's deletes, audit entry and event commit together.
  const { releasedHashes } = await db.$transaction(async (tx) => {
    const processedIds: string[] = [];
    const releasedHashes: string[] = [];
    let bytes = 0n;
    for (const version of expired) {
      // False when a user's delete or purge of this version got there first.
      if (
        !(await db.objectVersions.markDeleted(version.id, SYSTEM_USER_ID, tx))
      )
        continue;
      processedIds.push(version.id);
      // A delete marker holds no blob ref; it expires like any old version.
      if (version.isDeleteMarker || !version.contentBlobHash) continue;
      releasedHashes.push(version.contentBlobHash);
      bytes += version.contentBlob?.sizeBytes ?? 0n;
    }
    // Bucket before blobs, as an upload takes them.
    await db.buckets.lockForWrite(bucket.id, tx);
    await db.contentBlobs.decRefMany(releasedHashes, tx);
    if (versioningEnabled && bytes > 0n) {
      await db.buckets.decrementUsage(bucket.id, bytes, tx);
    }
    if (processedIds.length > 0) {
      await recordLifecycleBatchTx(
        tx,
        bucket,
        "expireVersions",
        "objectVersion",
        processedIds.map((id) => ({ id }))
      );
    }
    return { processedIds, releasedHashes };
  });
  for (const hash of new Set(releasedHashes)) await safeEnqueueOrphan(hash);
  return {
    lastId: newLastId,
    hasMore: expired.length >= BATCH_LIMIT,
    processed: expired.length,
  };
}

/**
 * One tick of the "purge soft-deleted objects past grace" stage.
 * Mirrors the behavior of the previous monolithic sweep's third inner loop:
 * refund quota when versioning is on (those bytes were retained), decRef all
 * referenced blobs in one aggregated UPDATE, then cascade-drop object rows.
 */
async function tickPurgeSoftDeleted(
  bucket: LifecycleBucket,
  days: number,
  versioningEnabled: boolean,
  afterId: string
): Promise<{ lastId: string; hasMore: boolean; processed: number }> {
  const purgeable = await db.lifecyclePolicies.findSoftDeletedObjectsPastPurge(
    bucket.id,
    days,
    BATCH_LIMIT,
    afterId
  );
  if (purgeable.length === 0) {
    return { lastId: afterId, hasMore: false, processed: 0 };
  }

  let newLastId = afterId;
  for (const o of purgeable) if (o.id > newLastId) newLastId = o.id;

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const { freedHashes } = await db.objects.purgeSoftDeletedObjects(
    bucket.id,
    purgeable.map((o) => o.id),
    cutoff,
    versioningEnabled,
    (tx, ids) =>
      recordLifecycleBatchTx(
        tx,
        bucket,
        "purgeSoftDeleted",
        "object",
        ids.map((id) => ({ id }))
      )
  );

  for (const hash of freedHashes) await safeEnqueueOrphan(hash);

  return {
    lastId: newLastId,
    hasMore: purgeable.length >= BATCH_LIMIT,
    processed: purgeable.length,
  };
}

// --- Worker processors ----------------------------------------------------

/**
 * Orchestrator. Runs daily. Enqueues:
 *   - one `lifecycle-sweep-policy` job per enabled bucket policy
 *   - one `lifecycle-sweep-per-object-ttl` job (singleton per day) for the
 *     cross-bucket per-object deleteAfter sweep.
 *
 * Dedupe is by jobId + today's day-stamp so multiple daily schedulers don't
 * produce N copies. Completes in O(#buckets) DB queries + enqueues.
 */
async function processLifecycleSweepOrchestrator(): Promise<void> {
  const policies = await db.lifecyclePolicies.listEnabled();
  const stamp = dayStamp();
  const policyQueue = getLifecyclePolicyQueue();
  const ttlQueue = getLifecyclePerObjectTtlQueue();

  let enqueued = 0;
  for (const policy of policies) {
    await policyQueue.add(
      "lifecycle-sweep-policy",
      {
        bucketId: policy.bucketId,
        continuation: 0,
      } satisfies LifecyclePolicyJobData,
      { jobId: `lifecycle-sweep-policy__${policy.bucketId}__${stamp}` }
    );
    enqueued++;
  }

  await ttlQueue.add(
    "lifecycle-sweep-per-object-ttl",
    { continuation: 0 } satisfies PerObjectTtlJobData,
    { jobId: `lifecycle-sweep-per-object-ttl__${stamp}` }
  );

  logger.info(
    {
      policies: enqueued,
      dayStamp: stamp,
    },
    "Lifecycle sweep orchestrator enqueued fan-out"
  );
}

/**
 * Per-bucket policy worker. Walks through a single bucket's policy stages
 * using a `{ kind, lastId }` cursor, time-boxed at `FILE_SERVICE_SWEEP_TIME_BOX_SECONDS`.
 *
 * Cursor progression: `expireObjects` → `expireVersions` → `purgeSoftDeleted`
 * → `done`. Within each stage we advance `lastId` until `hasMore=false`, then
 * move to the next stage on `lastId=0`. If the time-box or shutdown flag fires
 * mid-stage we re-enqueue with the same `(kind, lastId)` so the continuation
 * picks up exactly where we stopped.
 */
async function processLifecycleSweepPolicy(
  job: Job<LifecyclePolicyJobData>
): Promise<void> {
  if (isShuttingDown()) {
    // Re-enqueue unchanged; avoid doing any real work during shutdown.
    await reenqueuePolicy(job);
    return;
  }

  const { bucketId } = job.data;
  let policy;
  try {
    policy = await db.lifecyclePolicies.getByBucket(bucketId);
  } catch {
    logger.info({ bucketId }, "Policy no longer exists; exiting policy sweep");
    return;
  }
  if (!policy || !policy.enabled) {
    logger.info(
      {
        bucketId,
      },
      "Policy disabled or missing; exiting policy sweep"
    );
    return;
  }

  let versioningEnabled: boolean;
  let bucketCtx: LifecycleBucket;
  try {
    const bucket = await db.buckets.get(bucketId);
    versioningEnabled = bucket.versioningEnabled;
    bucketCtx = {
      id: bucket.id,
      name: bucket.name,
      organizationId: bucket.organizationId,
      serviceId: bucket.serviceId,
    };
  } catch {
    logger.info({ bucketId }, "Bucket missing; exiting policy sweep");
    return;
  }

  let cursor: PolicyCursor = job.data.cursor ?? {
    kind: "expireObjects",
    lastId: MIN_UUID,
  };

  const result = await createTimeBoxedLoop<PolicyCursor>({
    job,
    initialCursor: cursor,
    progressMeta: { bucketId, stage: cursor.kind },
    tick: async (current) => {
      const c = current ?? cursor;
      // Advance stages when disabled or exhausted.
      if (c.kind === "expireObjects") {
        if (policy!.expireObjectsAfterDays == null) {
          return {
            cursor: { kind: "expireVersions", lastId: MIN_UUID },
            hasMore: true,
            processed: 0,
          };
        }
        const res = await tickExpireObjects(
          bucketCtx,
          policy!.expireObjectsAfterDays,
          c.lastId
        );
        if (!res.hasMore) {
          return {
            cursor: { kind: "expireVersions", lastId: MIN_UUID },
            hasMore: true,
            processed: res.processed,
          };
        }
        return {
          cursor: { kind: "expireObjects", lastId: res.lastId },
          hasMore: true,
          processed: res.processed,
        };
      }
      if (c.kind === "expireVersions") {
        if (policy!.expireVersionsAfterDays == null) {
          return {
            cursor: { kind: "purgeSoftDeleted", lastId: MIN_UUID },
            hasMore: true,
            processed: 0,
          };
        }
        const res = await tickExpireVersions(
          bucketCtx,
          policy!.expireVersionsAfterDays,
          versioningEnabled,
          c.lastId
        );
        if (!res.hasMore) {
          return {
            cursor: { kind: "purgeSoftDeleted", lastId: MIN_UUID },
            hasMore: true,
            processed: res.processed,
          };
        }
        return {
          cursor: { kind: "expireVersions", lastId: res.lastId },
          hasMore: true,
          processed: res.processed,
        };
      }
      if (c.kind === "purgeSoftDeleted") {
        if (policy!.purgeSoftDeletedAfterDays == null) {
          return {
            cursor: { kind: "done", lastId: MIN_UUID },
            hasMore: false,
            processed: 0,
          };
        }
        const res = await tickPurgeSoftDeleted(
          bucketCtx,
          policy!.purgeSoftDeletedAfterDays,
          versioningEnabled,
          c.lastId
        );
        if (!res.hasMore) {
          return {
            cursor: { kind: "done", lastId: MIN_UUID },
            hasMore: false,
            processed: res.processed,
          };
        }
        return {
          cursor: { kind: "purgeSoftDeleted", lastId: res.lastId },
          hasMore: true,
          processed: res.processed,
        };
      }
      return { cursor: c, hasMore: false, processed: 0 };
    },
  });

  if (!result.completed && result.resumeCursor) {
    cursor = result.resumeCursor;
    await reenqueuePolicy(job, cursor);
  }

  logger.info(
    {
      bucketId,
      completed: result.completed,
      iterations: result.iterations,
      totalProcessed: result.totalProcessed,
      cursor: result.resumeCursor,
    },
    "Lifecycle policy tick finished"
  );
}

async function reenqueuePolicy(
  job: Job<LifecyclePolicyJobData>,
  nextCursor?: PolicyCursor
): Promise<void> {
  const queue = getLifecyclePolicyQueue();
  const continuation = (job.data.continuation ?? 0) + 1;
  await scheduleContinuation(
    queue,
    "lifecycle-sweep-policy",
    {
      bucketId: job.data.bucketId,
      cursor: nextCursor ?? job.data.cursor,
      continuation,
    } satisfies LifecyclePolicyJobData,
    {
      jobId: `lifecycle-sweep-policy__${job.data.bucketId}__${dayStamp()}__c${continuation}`,
    }
  );
}

/**
 * Per-object TTL worker. Cross-bucket: walks `findExpiredDeleteAfter` in
 * batches, removing each bucket's share of a batch with one
 * `removeExpiredObjects` call. Time-boxed and
 * re-enqueues a continuation until exhausted.
 */
async function processLifecycleSweepPerObjectTtl(
  job: Job<PerObjectTtlJobData>
): Promise<void> {
  if (isShuttingDown()) {
    await reenqueuePerObjectTtl(job);
    return;
  }

  let cursor: PerObjectTtlCursor = job.data.cursor ?? { lastId: MIN_UUID };

  const result = await createTimeBoxedLoop<PerObjectTtlCursor>({
    job,
    initialCursor: cursor,
    progressMeta: { stage: "per-object-ttl" },
    tick: async (current) => {
      const c = current ?? cursor;
      const expired = await db.lifecyclePolicies.findExpiredDeleteAfter(
        BATCH_LIMIT,
        c.lastId
      );
      if (expired.length === 0) {
        return { cursor: c, hasMore: false, processed: 0 };
      }
      let newLastId = c.lastId;
      // One batch per bucket: its deletes, audit entry and webhook event in
      // one transaction.
      const idsByBucket = new Map<number, string[]>();
      for (const obj of expired) {
        if (obj.id > newLastId) newLastId = obj.id;
        idsByBucket.set(obj.bucketId, [
          ...(idsByBucket.get(obj.bucketId) ?? []),
          obj.id,
        ]);
      }
      for (const [bucketId, ids] of idsByBucket) {
        try {
          const row = await db.buckets.get(bucketId);
          const bucket = {
            id: row.id,
            name: row.name,
            organizationId: row.organizationId,
            serviceId: row.serviceId,
          };
          const removed = await db.objects.removeExpiredObjects(
            bucket.id,
            ids,
            { deleteAfterBefore: new Date() },
            SYSTEM_USER_ID,
            (tx, objects) =>
              recordLifecycleBatchTx(
                tx,
                bucket,
                "perObjectTtl",
                "object",
                objects
              )
          );
          for (const r of removed) {
            for (const hash of r.releasedBlobHashes) {
              await safeEnqueueOrphan(hash);
            }
          }
        } catch (err) {
          // Bucket may be deleted; skip gracefully. Its objects are also
          // tombstoned by the bucket-cleanup job.
          logger.debug(
            {
              bucketId,
              err,
            },
            "per-object TTL skip"
          );
        }
      }
      return {
        cursor: { lastId: newLastId },
        hasMore: expired.length >= BATCH_LIMIT,
        processed: expired.length,
      };
    },
  });

  if (!result.completed && result.resumeCursor) {
    cursor = result.resumeCursor;
    await reenqueuePerObjectTtl(job, cursor);
  }

  logger.info(
    {
      completed: result.completed,
      totalProcessed: result.totalProcessed,
    },
    "Lifecycle per-object TTL tick finished"
  );
}

async function reenqueuePerObjectTtl(
  job: Job<PerObjectTtlJobData>,
  nextCursor?: PerObjectTtlCursor
): Promise<void> {
  const queue = getLifecyclePerObjectTtlQueue();
  const continuation = (job.data.continuation ?? 0) + 1;
  await scheduleContinuation(
    queue,
    "lifecycle-sweep-per-object-ttl",
    {
      cursor: nextCursor ?? job.data.cursor,
      continuation,
    } satisfies PerObjectTtlJobData,
    {
      jobId: `lifecycle-sweep-per-object-ttl__${dayStamp()}__c${continuation}`,
    }
  );
}

// --- Lifecycle: worker start/stop -----------------------------------------

export async function startLifecycleSweep(): Promise<void> {
  const orchestratorQueue = getLifecycleOrchestratorQueue();

  orchestratorWorker = new TrackedWorker(
    LIFECYCLE_SWEEP_ORCHESTRATOR_QUEUE,
    async () => {
      await processLifecycleSweepOrchestrator();
    },
    { connection: getRedisClient().duplicate(), concurrency: 1 }
  );
  orchestratorWorker.on("failed", (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        err,
      },
      "Lifecycle orchestrator failed"
    );
  });

  policyWorker = new TrackedWorker<LifecyclePolicyJobData>(
    LIFECYCLE_SWEEP_POLICY_QUEUE,
    async (job) => {
      await processLifecycleSweepPolicy(job);
    },
    // 4 buckets at a time — meaningful parallelism without swamping pg.
    { connection: getRedisClient().duplicate(), concurrency: 4 }
  );
  policyWorker.on("failed", (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        bucketId: job?.data?.bucketId,
        err,
      },
      "Lifecycle policy sweep failed"
    );
  });

  perObjectTtlWorker = new TrackedWorker<PerObjectTtlJobData>(
    LIFECYCLE_SWEEP_PER_OBJECT_TTL_QUEUE,
    async (job) => {
      await processLifecycleSweepPerObjectTtl(job);
    },
    { connection: getRedisClient().duplicate(), concurrency: 1 }
  );
  perObjectTtlWorker.on("failed", (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        err,
      },
      "Lifecycle per-object TTL failed"
    );
  });

  await orchestratorQueue.upsertJobScheduler(
    "lifecycle-sweep-orchestrator-scheduler",
    { every: JOB_INTERVAL_MS },
    { name: "lifecycle-sweep-orchestrator" }
  );
  logger.info(
    {
      intervalMs: JOB_INTERVAL_MS,
    },
    "Lifecycle sweep workers started"
  );
}

export async function stopLifecycleSweep(): Promise<void> {
  await Promise.allSettled(
    [orchestratorWorker, policyWorker, perObjectTtlWorker]
      .filter((w): w is Worker => !!w)
      .map((w) => w.close())
  );
  orchestratorWorker = null;
  policyWorker = null;
  perObjectTtlWorker = null;
}

export {
  processLifecycleSweepOrchestrator,
  processLifecycleSweepPolicy,
  processLifecycleSweepPerObjectTtl,
};
