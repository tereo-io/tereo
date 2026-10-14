import { retireMissing } from "../utils/registry.js";
import { TrackedWorker } from "./workerRegistry.js";
import { getRedisClient } from "../utils/redis.js";
import { isShuttingDown } from "./jobUtils.js";
import { logger } from "../utils/logger.js";
import { Queue, Worker } from "bullmq";
import {
  REMOVAL_POLICIES,
  RETRY_POLICIES,
  createQueue,
} from "../utils/bullmq.js";

// Hourly — retire permissions, system roles, buckets and event types missing
// from their service's declaration for longer than the grace period (24 h by
// default). Hourly is fine-grained enough against a grace measured in hours.
const REGISTRY_RETIREMENT_QUEUE = "core-registry-retirement";
const JOB_INTERVAL_MS = 60 * 60 * 1000;

let queue: Queue | null = null;
let worker: Worker | null = null;

export async function startRegistryRetirement(): Promise<void> {
  queue = createQueue(REGISTRY_RETIREMENT_QUEUE, {
    defaultJobOptions: {
      ...RETRY_POLICIES.MAINTENANCE,
      ...REMOVAL_POLICIES.DEFAULT,
    },
  });
  worker = new TrackedWorker(
    REGISTRY_RETIREMENT_QUEUE,
    async () => {
      if (isShuttingDown()) return;
      await retireMissing();
    },
    { connection: getRedisClient().duplicate(), concurrency: 1 }
  );
  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Registry retirement failed");
  });

  await queue.upsertJobScheduler(
    "registry-retirement-scheduler",
    { every: JOB_INTERVAL_MS },
    { name: "registry-retirement" }
  );
}

export async function stopRegistryRetirement(): Promise<void> {
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
}
