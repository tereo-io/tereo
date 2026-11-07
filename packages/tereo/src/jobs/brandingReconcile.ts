import { invalidateBranding } from "../utils/branding/resolve.js";
import { TrackedWorker } from "./workerRegistry.js";
import { getRedisClient } from "../utils/redis.js";
import { isShuttingDown } from "./jobUtils.js";
import { logger } from "../utils/logger.js";
import { Queue, Worker } from "bullmq";
import db from "../utils/db/index.js";
import {
  BRANDING_BUCKET,
  BRANDING_IMAGE_GRACE_MS,
} from "../utils/branding/storage.js";
import {
  REMOVAL_POLICIES,
  RETRY_POLICIES,
  createQueue,
} from "../utils/bullmq.js";

// Daily — start the expiry clock on branding images no profile references.
// Deleting a client cascades its profile away without releasing its images,
// and this is what lets the per-object TTL sweep remove them.
const BRANDING_RECONCILE_QUEUE = "core-branding-reconcile";
const JOB_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Returns how many objects were marked. */
export async function processBrandingReconcile(
  now: Date = new Date()
): Promise<number> {
  const marked = await db.$transaction(async (tx) => {
    // Lock the candidates, skipping any a profile save holds: that save is
    // about to reference it. The references are read in a fresh statement
    // after the lock, so a save that committed meanwhile is seen.
    const candidates = await tx.$queryRaw<{ id: string }[]>`
      SELECT o."id" FROM "files"."objects" o
      JOIN "files"."buckets" b ON b."id" = o."bucket_id"
      WHERE b."name" = ${BRANDING_BUCKET}
        AND o."deleted_at" IS NULL
        AND o."delete_after" IS NULL
      ORDER BY o."id"
      FOR UPDATE OF o SKIP LOCKED
    `;
    if (candidates.length === 0) return 0;
    const referenced = await db.brandingProfiles.referencedObjectIds(tx);
    const orphaned = candidates
      .map((row) => row.id)
      .filter((id) => !referenced.has(id));
    if (orphaned.length === 0) return 0;
    return await tx.$executeRaw`
      UPDATE "files"."objects"
      SET "delete_after" = ${new Date(now.getTime() + BRANDING_IMAGE_GRACE_MS)}
      WHERE "id" = ANY(${orphaned}::uuid[])
    `;
  });
  if (marked > 0) await invalidateBranding();
  return marked;
}

let queue: Queue | null = null;
let worker: Worker | null = null;

export async function startBrandingReconcile(): Promise<void> {
  queue = createQueue(BRANDING_RECONCILE_QUEUE, {
    defaultJobOptions: {
      ...RETRY_POLICIES.MAINTENANCE,
      ...REMOVAL_POLICIES.DEFAULT,
    },
  });
  worker = new TrackedWorker(
    BRANDING_RECONCILE_QUEUE,
    async () => {
      if (isShuttingDown()) return;
      const marked = await processBrandingReconcile();
      if (marked > 0) {
        logger.info({ marked }, "Marked orphaned branding images for expiry");
      }
    },
    { connection: getRedisClient().duplicate(), concurrency: 1 }
  );
  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Branding reconcile failed");
  });

  await queue.upsertJobScheduler(
    "branding-reconcile-scheduler",
    { every: JOB_INTERVAL_MS },
    { name: "branding-reconcile" }
  );
}

export async function stopBrandingReconcile(): Promise<void> {
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
}
