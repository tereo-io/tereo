import { notifyRevoked, revokeBrowserSessions } from "../utils/sessions.js";
import { REMOVAL_POLICIES, createQueue } from "../utils/bullmq.js";
import { recordSessionsRevoked } from "../utils/sessionEvents.js";
import { TrackedWorker } from "./workerRegistry.js";
import { NotFoundError } from "../utils/errors.js";
import { getRedisClient } from "../utils/redis.js";
import { logger } from "../utils/logger.js";
import type { Job, Queue } from "bullmq";
import db from "../utils/db/index.js";

const PROVIDER_DEACTIVATION_SESSION_SWEEP_QUEUE =
  "core-provider-deactivation-session-sweep";
const JOB_NAME = "provider-deactivation-session-sweep";

export interface ProviderDeactivationSessionSweepJobData {
  actor: { userId: string; email: string | null };
  providerId: string;
  /** Set for a retry: the users the previous attempt failed to sign out. */
  userIds?: string[];
}

let queue: Queue<ProviderDeactivationSessionSweepJobData> | null = null;
let worker: TrackedWorker<ProviderDeactivationSessionSweepJobData> | null =
  null;

export const getProviderDeactivationSessionSweepQueue = () => {
  // Enqueued from api processes too, which never start the worker.
  queue ??= createQueue<ProviderDeactivationSessionSweepJobData>(
    PROVIDER_DEACTIVATION_SESSION_SWEEP_QUEUE,
    {
      defaultJobOptions: {
        // Refresh does not look at the provider, so a user this misses keeps
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
 * The provider's slug and the users holding an identity at it, read as the
 * provider is now: nothing once it is gone or active again.
 */
const deactivatedProvider = async (providerId: string) => {
  const provider = await db.identityProviders.get(providerId).catch((err) => {
    if (err instanceof NotFoundError) return null;
    throw err;
  });
  if (!provider || provider.isActive) return null;
  return {
    slug: provider.slug,
    users: await db.userIdentities.usersAtProvider(providerId),
  };
};

/**
 * Ends the sessions the user signed in to through an identity provider: the
 * SSO sessions, every token family begun by such a login, and the login
 * steps the deactivated provider vouched for. Sessions do not record which
 * provider, so those from another provider end too; password sessions stay.
 */
const endFederatedSessions = async (
  actor: ProviderDeactivationSessionSweepJobData["actor"],
  user: { id: string; email: string },
  slug: string
) => {
  const revoked = await db.$transaction(
    async (tx) => {
      await db.users.lockForSessionEnd(tx, { userIds: [user.id] });
      const revoked = await revokeBrowserSessions(tx, {
        userSessionIds: await db.userSessions.getFederatedIdsByUserId(
          user.id,
          tx
        ),
        authCodeIds: await db.authorizationCode.getFederatedIdsByUserId(
          user.id,
          tx
        ),
      });
      await db.loginFlows.deletePendingFromProvider(user.id, slug, tx);
      await recordSessionsRevoked(actor, user)(
        tx,
        revoked.tokens.map((token) => token.id),
        revoked.ssoSessionIds
      );
      return revoked;
    },
    { timeout: 30_000 }
  );
  notifyRevoked(revoked);
};

/**
 * Each user in their own transaction, audited and emitted. One user's
 * failure is logged and does not stop the rest; returns the ids of those
 * that failed.
 */
const endSessionsOf = async (
  { actor, providerId }: ProviderDeactivationSessionSweepJobData,
  slug: string,
  users: { id: string; email: string }[]
) => {
  const failed: string[] = [];
  for (const user of users) {
    try {
      await endFederatedSessions(actor, user, slug);
    } catch (err) {
      logger.error(
        { err, userId: user.id, providerId },
        "Could not end the federated sessions of a deactivated provider's user"
      );
      failed.push(user.id);
    }
  }
  return failed;
};

/**
 * A deactivated provider can vouch for no one, so the sessions its users
 * obtained through it must not outlive the change. A retry takes only the
 * users the attempt before failed: going over the rest again would also end
 * the sessions they have started since through another provider.
 */
export async function processProviderDeactivationSessionSweep(
  job: Pick<Job<ProviderDeactivationSessionSweepJobData>, "data" | "updateData">
): Promise<void> {
  const { providerId, userIds } = job.data;
  const provider = await deactivatedProvider(providerId);
  if (!provider) return;
  const users = userIds
    ? provider.users.filter((user) => userIds.includes(user.id))
    : provider.users;
  const failed = await endSessionsOf(job.data, provider.slug, users);
  if (failed.length > 0) {
    await job.updateData({ ...job.data, userIds: failed });
    throw new Error(
      `Could not end the federated sessions of ${failed.length} user(s) of a deactivated provider`
    );
  }
}

/**
 * Run after the deactivation commits. `changedAt` (the provider's
 * `updatedAt`) names the job, so one deactivation is swept once. While the
 * queue is unreachable the sweep runs here instead, without retries.
 */
export async function enqueueProviderDeactivationSessionSweep(
  data: ProviderDeactivationSessionSweepJobData,
  changedAt: Date
): Promise<void> {
  try {
    await getProviderDeactivationSessionSweepQueue().add(JOB_NAME, data, {
      jobId: `${data.providerId}__${changedAt.getTime()}`,
    });
  } catch (err) {
    logger.error(
      { err, providerId: data.providerId },
      "Could not enqueue the provider deactivation session sweep; running it inline"
    );
    const provider = await deactivatedProvider(data.providerId);
    if (provider) await endSessionsOf(data, provider.slug, provider.users);
  }
}

export async function startProviderDeactivationSessionSweep(): Promise<void> {
  worker = new TrackedWorker<ProviderDeactivationSessionSweepJobData>(
    PROVIDER_DEACTIVATION_SESSION_SWEEP_QUEUE,
    processProviderDeactivationSessionSweep,
    { connection: getRedisClient().duplicate(), concurrency: 2 }
  );
  worker.on("failed", (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        providerId: job?.data?.providerId,
        userIds: job?.data?.userIds,
        attemptsMade: job?.attemptsMade,
        err,
      },
      "Provider deactivation session sweep failed"
    );
  });
}

export async function stopProviderDeactivationSessionSweep(): Promise<void> {
  await worker?.close();
  worker = null;
}

export async function closeProviderDeactivationSessionSweepQueue(): Promise<void> {
  const closing = queue;
  queue = null;
  await closing?.close();
}
