import { Queue } from "bullmq";
import {
  createQueue,
  REMOVAL_POLICIES,
  RETRY_POLICIES,
} from "../utils/bullmq.js";

let entryRetentionQueue: Queue | null = null;

export function getEntryRetentionQueue(): Queue {
  if (!entryRetentionQueue) {
    entryRetentionQueue = createQueue("audit-entry-retention", {
      defaultJobOptions: {
        ...RETRY_POLICIES.ONESHOT,
        ...REMOVAL_POLICIES.MAINTENANCE,
      },
    });
  }
  return entryRetentionQueue;
}

export async function closeAuditQueues(): Promise<void> {
  if (entryRetentionQueue) {
    await entryRetentionQueue.close();
    entryRetentionQueue = null;
  }
}
