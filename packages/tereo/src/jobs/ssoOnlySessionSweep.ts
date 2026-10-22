import { REMOVAL_POLICIES, createQueue } from "../utils/bullmq.js";
import { recordSessionsRevoked } from "../utils/sessionEvents.js";
import { endUserSessions } from "../utils/sessions.js";
import { TrackedWorker } from "./workerRegistry.js";
import { NotFoundError } from "../utils/errors.js";
import { getRedisClient } from "../utils/redis.js";
import { logger } from "../utils/logger.js";
import type { Job, Queue } from "bullmq";
import db from "../utils/db/index.js";

const SSO_ONLY_SESSION_SWEEP_QUEUE = "core-sso-only-session-sweep";
const JOB_NAME = "sso-only-session-sweep";

export interface SsoOnlySessionSweepJobData {
  actor: { userId: string; email: string | null };
  providerId: string;
  domainId: string;
  /** Set for a retry: the users the previous attempt failed to sign out. */
  userIds?: string[];
}

let queue: Queue<SsoOnlySessionSweepJobData> | null = null;
let worker: TrackedWorker<SsoOnlySessionSweepJobData> | null = null;

export const getSsoOnlySessionSweepQueue = () => {
  // Enqueued from api processes too, which never start the worker.
  queue ??= createQueue<SsoOnlySessionSweepJobData>(
    SSO_ONLY_SESSION_SWEEP_QUEUE,
    {
      defaultJobOptions: {
        // Refresh does not enforce SSO-only, so a user this misses keeps
        // their sessions: keep at it for over an hour before giving up.
        attempts: 10,
        backoff: { type: "exponential", delay: 10_000 },
        ...REMOVAL_POLICIES.TRANSIENT,
      },
    }
  );
  return queue;
};

/**
 * The users at the domain who hold an identity at another provider, read as
 * the domain is now: none once it is gone or no longer SSO-only.
 */
const usersLinkedElsewhere = async (providerId: string, domainId: string) => {
  const domain = await db.identityProviders
    .getDomain(providerId, domainId)
    .catch((err) => {
      if (err instanceof NotFoundError) return null;
      throw err;
    });
  if (!domain?.ssoOnly) return [];
  return await db.userIdentities.usersAtDomainLinkedElsewhere(
    domain.domain,
    providerId
  );
};

/**
 * Ends each user's sessions, audited and emitted, in their own transaction.
 * One user's failure is logged and does not stop the rest; returns the ids
 * of those that failed.
 */
const endSessionsOf = async (
  { actor, providerId, domainId }: SsoOnlySessionSweepJobData,
  users: { id: string; email: string }[]
) => {
  const failed: string[] = [];
  for (const user of users) {
    try {
      await endUserSessions(user.id, null, recordSessionsRevoked(actor, user));
    } catch (err) {
      logger.error(
        { err, userId: user.id, providerId, domainId },
        "Could not end the sessions of a user at an SSO-only domain"
      );
      failed.push(user.id);
    }
  }
  return failed;
};

/**
 * Once a domain is SSO-only its provider is its users' only way in, so a
 * session from an identity at another provider must not outlive the change.
 * A retry takes only the users the attempt before failed: ending a user's
 * sessions ends all of them, so going over the rest again would also end
 * the SSO sessions they have started since.
 */
export async function processSsoOnlySessionSweep(
  job: Pick<Job<SsoOnlySessionSweepJobData>, "data" | "updateData">
): Promise<void> {
  const { providerId, domainId, userIds } = job.data;
  let users = await usersLinkedElsewhere(providerId, domainId);
  if (userIds) users = users.filter((user) => userIds.includes(user.id));
  const failed = await endSessionsOf(job.data, users);
  if (failed.length > 0) {
    await job.updateData({ ...job.data, userIds: failed });
    throw new Error(
      `Could not end the sessions of ${failed.length} user(s) at an SSO-only domain`
    );
  }
}

/**
 * Run after the change that made the domain SSO-only commits. `changedAt`
 * (the domain's `updatedAt`) names the job, so one change is swept once.
 * While the queue is unreachable the sweep runs here instead, without
 * retries.
 */
export async function enqueueSsoOnlySessionSweep(
  data: SsoOnlySessionSweepJobData,
  changedAt: Date
): Promise<void> {
  try {
    await getSsoOnlySessionSweepQueue().add(JOB_NAME, data, {
      jobId: `${data.domainId}__${changedAt.getTime()}`,
    });
  } catch (err) {
    logger.error(
      { err, providerId: data.providerId, domainId: data.domainId },
      "Could not enqueue the SSO-only session sweep; running it inline"
    );
    await endSessionsOf(
      data,
      await usersLinkedElsewhere(data.providerId, data.domainId)
    );
  }
}

export async function startSsoOnlySessionSweep(): Promise<void> {
  worker = new TrackedWorker<SsoOnlySessionSweepJobData>(
    SSO_ONLY_SESSION_SWEEP_QUEUE,
    processSsoOnlySessionSweep,
    { connection: getRedisClient().duplicate(), concurrency: 2 }
  );
  worker.on("failed", (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        domainId: job?.data?.domainId,
        userIds: job?.data?.userIds,
        attemptsMade: job?.attemptsMade,
        err,
      },
      "SSO-only session sweep failed"
    );
  });
}

export async function stopSsoOnlySessionSweep(): Promise<void> {
  await worker?.close();
  worker = null;
}

export async function closeSsoOnlySessionSweepQueue(): Promise<void> {
  const closing = queue;
  queue = null;
  await closing?.close();
}
