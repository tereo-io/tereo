import { TrackedWorker } from "./workerRegistry.js";
import { getRedisClient } from "../utils/redis.js";
import { isShuttingDown } from "./jobUtils.js";
import { logger } from "../utils/logger.js";
import { Queue, Worker } from "bullmq";
import db from "../utils/db/index.js";
import {
  REMOVAL_POLICIES,
  RETRY_POLICIES,
  createQueue,
} from "../utils/bullmq.js";

// Hourly — purge expired auth rows: SSO, consent, org-selection and TOTP
// sessions as soon as they expire, tokens and codes a grace period later.
const AUTH_CLEANUP_QUEUE = "core-auth-cleanup";
const JOB_INTERVAL_MS = 60 * 60 * 1000;

// Kept past expiry so a token or code is still there to explain a late
// "invalid_grant" or "invalid_token" while someone investigates. Refresh tokens
// are deleted by expiry alone, never by revocation: a revoked refresh token
// must outlive its family (every rotation shares the family's expiry) because
// replaying it is what triggers family revocation. A code goes only once its
// family is gone, since deleting it cascades to the family's tokens.
export const AUTH_TOKEN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

let queue: Queue | null = null;
let worker: Worker | null = null;

export async function cleanupExpiredAuthRows(now = new Date()) {
  const cutoff = new Date(now.getTime() - AUTH_TOKEN_GRACE_MS);
  // Tokens before codes: a code is deleted only once no token references it.
  const accessTokens = await db.accessTokens.deleteExpiredBefore(cutoff);
  const refreshTokens = await db.refreshTokens.deleteExpiredBefore(cutoff);
  const authorizationCodes =
    await db.authorizationCode.deleteExpiredBefore(cutoff);
  return {
    accessTokens,
    refreshTokens,
    authorizationCodes,
    userSessions: await db.userSessions.cleanupExpiredUserSessions(),
    consentSessions: await db.consent.cleanupExpiredConsentSessions(),
    orgSelectionSessions: await db.orgSelectionSessions.cleanupExpired(),
    totpVerifications: await db.totp.cleanupExpiredVerificationSessions(),
    totpSetupSessions: await db.totp.cleanupExpiredSetupSessions(),
    totpSetupGrants: await db.totp.cleanupExpiredSetupGrants(),
    upstreamAuthSessions: await db.upstreamAuth.cleanupExpiredSessions(),
    identityLinkGrants: await db.upstreamAuth.cleanupExpiredLinkGrants(),
    identityInvites: await db.userIdentities.cleanupExpiredInvites(),
  };
}

export async function startAuthCleanup(): Promise<void> {
  queue = createQueue(AUTH_CLEANUP_QUEUE, {
    defaultJobOptions: {
      ...RETRY_POLICIES.MAINTENANCE,
      ...REMOVAL_POLICIES.DEFAULT,
    },
  });
  worker = new TrackedWorker(
    AUTH_CLEANUP_QUEUE,
    async () => {
      if (isShuttingDown()) return;
      const deleted = await cleanupExpiredAuthRows();
      logger.info({ deleted }, "Auth cleanup completed");
    },
    { connection: getRedisClient().duplicate(), concurrency: 1 }
  );
  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Auth cleanup failed");
  });

  await queue.upsertJobScheduler(
    "auth-cleanup-scheduler",
    { every: JOB_INTERVAL_MS },
    { name: "auth-cleanup" }
  );
}

export async function stopAuthCleanup(): Promise<void> {
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
}
