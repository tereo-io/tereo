import { BlobListCursor, blobStore } from "../utils/blobStore/index.js";
import { getRedisClient, redisKey } from "../utils/redis.js";
import { TrackedWorker } from "./workerRegistry.js";
import { logger } from "../utils/logger.js";
import db from "../utils/db/index.js";
import { Job, Worker } from "bullmq";
import env from "../env.js";
import {
  createTimeBoxedLoop,
  isShuttingDown,
  scheduleContinuation,
} from "./jobUtils.js";
import {
  DISK_BLOB_RECONCILIATION_ORCHESTRATOR_QUEUE,
  DISK_BLOB_RECONCILIATION_SHARD_QUEUE,
  getDiskReconOrchestratorQueue,
  getDiskReconShardQueue,
} from "./queues.js";

// Weekly, staggered so it doesn't race the daily lifecycle sweep.
const JOB_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
// A blob can only be deleted once we've observed it on disk with no matching
// content_blobs row for at least this long. This is measured by the age of
// the per-shard "first seen missing" timestamp in Redis — NOT by the file's
// mtime on disk, which can be forged by backup restores, cross-filesystem
// copies, or container image bakes. Mtime is not a safety signal.
const MIN_AGE_MS = 24 * 60 * 60 * 1000;
// How long an unused "first seen missing" entry lingers before Redis expires
// it. Several intervals, so a run that comes late, or a shard whose pass the
// per-run ceiling spreads over more than one run, still finds the previous
// sighting; it also collects itself if a shard is retired or renamed.
const SEEN_MISSING_TTL_SECONDS = (4 * JOB_INTERVAL_MS) / 1000;
const SEEN_MISSING_KEY_PREFIX = "file-service:reconcile:seen-missing";
// Where a shard's pass stopped at the per-run ceiling, for the next run.
const SHARD_CURSOR_KEY_PREFIX = "file-service:reconcile:cursor";
const SHARD_CURSOR_TTL_SECONDS = (4 * JOB_INTERVAL_MS) / 1000;

let orchestratorWorker: Worker | null = null;
let shardWorker: Worker | null = null;

function weekStamp(d = new Date()): string {
  // ISO week-ish key: YYYYww. Good enough to dedupe continuation id bursts
  // to within a week.
  const y = d.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  const diffDays = Math.floor((d.getTime() - start) / (24 * 60 * 60 * 1000));
  const week = Math.floor(diffDays / 7);
  return `${y}w${String(week).padStart(2, "0")}`;
}

// --- Orchestrator ---------------------------------------------------------

/**
 * Discover the blob shards (the first two hash characters) that hold blobs and
 * enqueue one reconciliation job per shard. Uses `jobId` dedupe so the daily
 * scheduler firing twice in one week collapses to N jobs total.
 */
async function processDiskReconOrchestrator(): Promise<void> {
  const stamp = weekStamp();
  const shardQueue = getDiskReconShardQueue();

  const shards = await blobStore.listShards();
  if (shards.length === 0) {
    logger.info("Disk reconciliation: no blob shards; nothing to do");
    return;
  }

  let enqueued = 0;
  for (const shard of shards) {
    await shardQueue.add(
      "disk-blob-reconciliation-shard",
      { shard, continuation: 0 } satisfies ShardJobData,
      { jobId: `disk-blob-reconciliation-shard__${shard}__${stamp}` }
    );
    enqueued++;
  }

  logger.info(
    {
      enqueued,
      weekStamp: stamp,
    },
    "Disk reconciliation orchestrator enqueued shards"
  );
}

// --- Per-shard worker -----------------------------------------------------

type ShardCursor = BlobListCursor;

interface ShardJobData {
  shard: string;
  cursor?: ShardCursor;
  /** Running count enforced across continuations so we honor the per-shard ceiling. */
  filesScanned?: number;
  filesRemoved?: number;
  continuation?: number;
}

/**
 * Redis hash key for the "first seen missing" bookkeeping of one (shard, sub)
 * pair. We namespace at the sub-shard level so each hash stays small (at most
 * a few thousand entries per sub on a typical deployment) and so entries can
 * age out via a single per-hash TTL.
 */
function seenMissingKey(shard: string, sub: string): string {
  return redisKey(`${SEEN_MISSING_KEY_PREFIX}:${shard}:${sub}`);
}

/**
 * Record-or-read the first-seen-missing timestamp for `hash` under this
 * sub-shard. Uses HSETNX so the original (oldest) timestamp is preserved
 * across re-observations, and refreshes the hash's TTL so idle entries
 * eventually age out.
 *
 * Returns the effective first-seen timestamp in ms (either the one we just
 * wrote or the pre-existing one).
 */
async function touchFirstSeenMissing(
  shard: string,
  sub: string,
  hash: string,
  now: number
): Promise<number> {
  const redis = getRedisClient();
  const key = seenMissingKey(shard, sub);
  const wrote = await redis.hsetnx(key, hash, String(now));
  // Refresh TTL on every access so active shards never expire out from under
  // us; idle shards age out naturally once the weekly job stops touching them.
  await redis.expire(key, SEEN_MISSING_TTL_SECONDS);
  if (wrote === 1) return now;
  const existing = await redis.hget(key, hash);
  const parsed = existing ? Number(existing) : NaN;
  return Number.isFinite(parsed) ? parsed : now;
}

function shardCursorKey(shard: string): string {
  return redisKey(`${SHARD_CURSOR_KEY_PREFIX}:${shard}`);
}

async function loadShardCursor(shard: string): Promise<ShardCursor> {
  const raw = await getRedisClient().get(shardCursorKey(shard));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ShardCursor;
  } catch {
    return {};
  }
}

async function saveShardCursor(
  shard: string,
  cursor: ShardCursor
): Promise<void> {
  await getRedisClient().set(
    shardCursorKey(shard),
    JSON.stringify(cursor),
    "EX",
    SHARD_CURSOR_TTL_SECONDS
  );
}

async function clearFirstSeenMissing(
  shard: string,
  sub: string,
  hash: string
): Promise<void> {
  const redis = getRedisClient();
  await redis.hdel(seenMissingKey(shard, sub), hash);
}

/**
 * Process up to `batchLimit` files from the current (shard, sub) cursor. The
 * caller iterates ticks until `hasMore=false` OR the shard's per-run ceiling
 * is hit.
 *
 * Deletion protocol:
 *   1. On every scanned file with no matching content_blobs row, upsert a
 *      "first-seen-missing" timestamp in Redis (HSETNX so repeat observations
 *      keep the original ts).
 *   2. Only unlink the file if the first-seen timestamp is at least
 *      MIN_AGE_MS old. First observation = skip; subsequent observations a
 *      day+ later = delete.
 *   3. If a file IS in the DB, clear any stale first-seen entry for it.
 *
 * This replaces the previous mtime check, which could be tricked by backup
 * restores / container image bakes / cross-FS copies producing files whose
 * mtime made them look old even though they had just been placed.
 */
async function tickShard(
  shard: string,
  cursor: ShardCursor,
  batchLimit: number,
  counters: { scanned: number; removed: number; dbChecked: number },
  ceiling: number
): Promise<{ cursor: ShardCursor; hasMore: boolean; processed: number }> {
  const now = Date.now();
  let processed = 0;
  // Where the listing resumes if this tick stops early: after the last blob
  // visited, or where it started when none was.
  let resume = cursor;

  for await (const listing of blobStore.listBlobs(shard, cursor)) {
    if (counters.scanned >= ceiling || processed >= batchLimit) {
      return { cursor: resume, hasMore: true, processed };
    }
    resume = listing.cursor;
    const { hash: name, location } = listing;
    const sub = listing.cursor.sub!;
    counters.scanned++;
    processed++;

    // A blob's name under the sharded layout is its hash. PK lookup.
    counters.dbChecked++;
    const row = await db.contentBlobs.getByHash(name);
    if (row) {
      // The blob is referenced — drop any stale "seen missing" bookkeeping so
      // a later orphan is aged from fresh instead of inheriting an old ts.
      await clearFirstSeenMissing(shard, sub, name);
      continue;
    }

    // No DB row. Record when we first noticed and only delete if we've
    // seen it missing for at least MIN_AGE_MS. This is the sole safety
    // window — mtime is no longer consulted.
    const firstSeen = await touchFirstSeenMissing(shard, sub, name, now);
    if (now - firstSeen < MIN_AGE_MS) continue;

    try {
      // Re-check and delete under the blob's lock: an upload creating the
      // row holds it from before it places its blob until it commits, so
      // its row is seen here or its blob lands after the delete.
      const removed = await db.$transaction(async (tx) => {
        await db.contentBlobs.lockHash(name, tx);
        if (await db.contentBlobs.getByHash(name, tx)) return false;
        // False when someone else (manual cleanup, another worker) already
        // removed it.
        return await blobStore.delete(location);
      });
      if (removed) counters.removed++;
      // Clean up the seen-missing entry after a delete so the hash doesn't
      // accumulate dead keys for already-removed blobs.
      await clearFirstSeenMissing(shard, sub, name);
    } catch (err) {
      logger.warn(
        {
          path: location,
          err,
        },
        "disk-blob-reconciliation unlink failed"
      );
    }
  }

  return { cursor: {}, hasMore: false, processed };
}

async function processDiskReconShard(job: Job<ShardJobData>): Promise<void> {
  if (isShuttingDown()) {
    await reenqueueShard(job);
    return;
  }

  const { shard } = job.data;
  const ceiling = env.FILE_SERVICE_DISK_RECONCILIATION_MAX_FILES_PER_SHARD;
  // A run's first job resumes where the last run's ceiling stopped it, so a
  // shard larger than the ceiling is covered over successive runs.
  let cursor: ShardCursor = job.data.cursor ?? (await loadShardCursor(shard));
  let shardFinished = false;
  const counters = {
    scanned: job.data.filesScanned ?? 0,
    removed: job.data.filesRemoved ?? 0,
    dbChecked: 0,
  };

  const result = await createTimeBoxedLoop<ShardCursor>({
    job,
    initialCursor: cursor,
    progressMeta: { shard, scanned: counters.scanned },
    tick: async (current) => {
      const res = await tickShard(
        shard,
        current ?? cursor,
        500,
        counters,
        ceiling
      );
      cursor = res.cursor;
      shardFinished = !res.hasMore;
      return {
        cursor: res.cursor,
        hasMore: res.hasMore && counters.scanned < ceiling,
        processed: res.processed,
      };
    },
  });

  if (shardFinished) {
    await getRedisClient().del(shardCursorKey(shard));
  } else {
    await saveShardCursor(shard, cursor);
  }

  if (!result.completed && counters.scanned < ceiling && result.resumeCursor) {
    await reenqueueShard(job, cursor, counters);
  }

  logger.info(
    {
      shard,
      completed: result.completed,
      scanned: counters.scanned,
      removed: counters.removed,
      dbChecked: counters.dbChecked,
    },
    "Disk blob reconciliation shard tick finished"
  );
}

async function reenqueueShard(
  job: Job<ShardJobData>,
  nextCursor?: ShardCursor,
  counters?: { scanned: number; removed: number }
): Promise<void> {
  const queue = getDiskReconShardQueue();
  const continuation = (job.data.continuation ?? 0) + 1;
  await scheduleContinuation(
    queue,
    "disk-blob-reconciliation-shard",
    {
      shard: job.data.shard,
      cursor: nextCursor ?? job.data.cursor,
      filesScanned: counters?.scanned ?? job.data.filesScanned,
      filesRemoved: counters?.removed ?? job.data.filesRemoved,
      continuation,
    } satisfies ShardJobData,
    {
      jobId: `disk-blob-reconciliation-shard__${job.data.shard}__${weekStamp()}__c${continuation}`,
    }
  );
}

// --- Worker lifecycle -----------------------------------------------------

export async function startDiskBlobReconciliation(): Promise<void> {
  const orchestratorQueue = getDiskReconOrchestratorQueue();

  orchestratorWorker = new TrackedWorker(
    DISK_BLOB_RECONCILIATION_ORCHESTRATOR_QUEUE,
    async () => {
      await processDiskReconOrchestrator();
    },
    { connection: getRedisClient().duplicate(), concurrency: 1 }
  );
  orchestratorWorker.on("failed", (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        err,
      },
      "Disk reconciliation orchestrator failed"
    );
  });

  shardWorker = new TrackedWorker<ShardJobData>(
    DISK_BLOB_RECONCILIATION_SHARD_QUEUE,
    async (job) => {
      await processDiskReconShard(job);
    },
    // Disk IO-bound; two shards at a time is a good default.
    { connection: getRedisClient().duplicate(), concurrency: 2 }
  );
  shardWorker.on("failed", (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        shard: job?.data?.shard,
        err,
      },
      "Disk reconciliation shard failed"
    );
  });

  await orchestratorQueue.upsertJobScheduler(
    "disk-blob-reconciliation-orchestrator-scheduler",
    { every: JOB_INTERVAL_MS },
    { name: "disk-blob-reconciliation-orchestrator" }
  );
  logger.info(
    {
      intervalMs: JOB_INTERVAL_MS,
    },
    "Disk blob reconciliation workers started"
  );
}

export async function stopDiskBlobReconciliation(): Promise<void> {
  await Promise.allSettled(
    [orchestratorWorker, shardWorker]
      .filter((w): w is Worker => !!w)
      .map((w) => w.close())
  );
  orchestratorWorker = null;
  shardWorker = null;
}

export { processDiskReconShard };
