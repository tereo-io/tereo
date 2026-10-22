import { CHANNELS, getAdapter } from "../utils/notifications/channels/index.js";
import { openConnectionSecrets } from "../utils/notifications/connections.js";
import { getDefaultOrganizationId } from "../utils/defaultOrganization.js";
import { canReadBucket, holdsBucketGrant } from "../utils/bucketAccess.js";
import type { StoredAttachment } from "../utils/notifications/accept.js";
import { toConnectionView } from "../utils/notifications/connections.js";
import { senderAccessSchema } from "../utils/notifications/accept.js";
import { takeSendToken } from "../utils/notifications/rateLimit.js";
import type { DeliveryRef } from "../utils/db/notifications.js";
import { SYSTEM_USER_ID } from "../definitions/index.js";
import { capToCeiling } from "../utils/coreAccess.js";
import { openBlobStream } from "../utils/storage.js";
import { BadRequestError } from "../utils/errors.js";
import { TrackedWorker } from "./workerRegistry.js";
import type { Prisma } from "../utils/db/prisma.js";
import { getRedisClient } from "../utils/redis.js";
import { DelayedError, type Job } from "bullmq";
import { prisma } from "../utils/db/prisma.js";
import { emitTx } from "../utils/outbox.js";
import { logger } from "../utils/logger.js";
import db from "../utils/db/index.js";
import { access } from "fs/promises";
import {
  PermanentSendError,
  type AttachmentStream,
  type NotificationChannel,
  type ResolvedRecipient,
  type SendResult,
} from "../utils/notifications/channels/types.js";
import type {
  Notification,
  NotificationConnection,
} from "../../prisma/generated/client/index.js";
import {
  NOTIFICATION_DELIVERY_ATTEMPTS,
  notificationQueueName,
  type NotificationDeliveryJobData,
} from "./notificationQueues.js";

/** How long a job waits for a connection to exist or be enabled. */
const NO_CONNECTION_DELAY_MS = 60_000;
/** How long a job waits after failing before it could claim the delivery. */
const PRE_CLAIM_RETRY_MS = 30_000;
/** Delays before such a failure spends one of the job's attempts instead. */
const MAX_PRE_CLAIM_DELAYS = 10;

let workers: TrackedWorker<NotificationDeliveryJobData>[] = [];

/** The connection a delivery goes through now: the named one, else the default. */
const resolveConnection = async (
  channel: NotificationChannel,
  connectionId: string | null
): Promise<NotificationConnection | null> => {
  const connection = connectionId
    ? await prisma.notificationConnection.findUnique({
        where: { id: connectionId },
      })
    : await db.notificationConnections.getDefault(channel);
  return connection?.isEnabled ? connection : null;
};

const attachmentMissing = (a: StoredAttachment) =>
  new PermanentSendError(
    "attachment_missing",
    `Version ${a.versionId} of object ${a.objectId} is no longer stored`
  );

const attachmentForbidden = (bucket: string) =>
  new PermanentSendError(
    "attachment_forbidden",
    `The sender can no longer read bucket "${bucket}"`
  );

/**
 * Accept checked that the sender could read every attachment's bucket; a
 * grant or permission revoked since must not still send its files. Checked
 * as at accept: the sender's live permissions in the token's organization,
 * capped by its scopes. Core reads every bucket.
 */
const assertAttachmentsReadable = async (
  notification: Notification,
  attachments: StoredAttachment[]
): Promise<void> => {
  if (attachments.length === 0) return;
  if (notification.senderUserId === SYSTEM_USER_ID) return;
  const buckets = [...new Set(attachments.map((a) => a.bucket))];
  const access = senderAccessSchema.safeParse(notification.senderAccess);
  const sender = await prisma.user.findUnique({
    where: { id: notification.senderUserId },
    select: { isActive: true },
  });
  if (!access.success || !sender?.isActive) {
    throw attachmentForbidden(buckets[0]);
  }
  const { organizationId, ceiling } = access.data;
  const auth = {
    userId: notification.senderUserId,
    organizationId,
    permissions: capToCeiling(
      await db.roles.getUserPermissions(
        notification.senderUserId,
        organizationId
      ),
      ceiling
    ),
  };
  for (const bucket of buckets) {
    if (!(await canReadBucket(auth, bucket))) throw attachmentForbidden(bucket);
  }
  // A public bucket serves anyone its current content, but its history only
  // grant holders (as at accept): a version made non-current since, or a
  // grant revoked since, must not still send.
  const history = await prisma.objectVersion.findMany({
    where: {
      id: { in: attachments.map((a) => a.versionId) },
      isCurrent: false,
      object: { bucket: { policy: "public" } },
    },
    select: { object: { select: { bucket: { select: { name: true } } } } },
  });
  for (const bucket of new Set(history.map((v) => v.object.bucket.name))) {
    if (!(await holdsBucketGrant(auth, bucket))) {
      throw attachmentForbidden(bucket);
    }
  }
};

/** Opens the version's blob when the adapter reads it; gone is permanent. */
const toAttachmentStream = (a: StoredAttachment): AttachmentStream => ({
  filename: a.filename,
  contentType: a.contentType,
  size: a.size,
  async open() {
    const version = await prisma.objectVersion.findFirst({
      where: {
        id: a.versionId,
        objectId: a.objectId,
        deletedAt: null,
        isDeleteMarker: false,
        object: {
          deletedAt: null,
          bucket: { name: a.bucket, deletedAt: null },
        },
      },
      include: { contentBlob: true },
    });
    const blob = version?.contentBlob;
    if (!blob) throw attachmentMissing(a);
    try {
      await access(blob.fsPath);
    } catch {
      throw attachmentMissing(a);
    }
    return openBlobStream(
      {
        fsPath: blob.fsPath,
        keyMaterial: {
          wrappedDek: Buffer.from(blob.wrappedDek),
          iv: Buffer.from(blob.iv),
          masterKeyVersion: blob.masterKeyVersion,
        },
      },
      blob.hash
    );
  },
});

interface StoredRecipient {
  address: string;
  as: string;
  userId?: string;
}

const toResolvedRecipient = (
  r: StoredRecipient
): ResolvedRecipient<{ as: string }> => ({
  address: r.address,
  userId: r.userId ?? null,
  options: { as: r.as },
});

/** What `last_error` records: the provider's reply, else the error's code. */
const describeFailure = (err: unknown): string => {
  if (err instanceof PermanentSendError) {
    return err.code === "smtp_rejected" ? err.message : err.code;
  }
  if (err instanceof BadRequestError) return err.code;
  return err instanceof Error ? err.message : String(err);
};

/** Delay the job without spending one of its attempts. */
const delay = async (
  job: Job<NotificationDeliveryJobData>,
  token: string | undefined,
  ms: number
): Promise<never> => {
  await job.moveToDelayed(Date.now() + ms, token);
  throw new DelayedError();
};

/** Tries at recording a sent delivery before giving up on this attempt. */
const RECORD_SENT_TRIES = 3;
const RECORD_SENT_BACKOFF_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One delivery attempt. Returns once the delivery is settled (sent, or failed
 * for good); throws to have BullMQ retry it with backoff. Attempts are
 * counted on the delivery as well as the job: a job the stale sweep re-queues
 * starts a fresh BullMQ budget, but the delivery's total stays within
 * NOTIFICATION_DELIVERY_ATTEMPTS.
 */
export async function processNotificationDelivery(
  job: Job<NotificationDeliveryJobData>,
  token?: string
): Promise<void> {
  const { deliveryId, notificationId } = job.data;
  const createdAt = new Date(job.data.notificationCreatedAt);
  const ref: DeliveryRef = { id: deliveryId, notificationCreatedAt: createdAt };

  const [delivery, notification] = await Promise.all([
    db.notifications.getDelivery(ref),
    db.notifications.get(notificationId, createdAt),
  ]);
  // Gone with its partition, or settled or claimed already.
  if (!delivery || !notification || delivery.status !== "pending") {
    logger.debug(
      { deliveryId, status: delivery?.status ?? null },
      "Skipping notification delivery that is not pending"
    );
    return;
  }
  const adapter = getAdapter(notification.channel);

  /**
   * Settle the delivery, roll the notification up and emit the event, in one
   * transaction. Nothing is rolled up or emitted when `update` applied to no
   * row (the delivery was reset or settled meanwhile). Returns whether it applied.
   */
  const settle = (
    status: "sent" | "failed",
    connectionSlug: string | null,
    update: (tx: Prisma.TransactionClient) => Promise<{ count: number }>
  ) =>
    prisma.$transaction(async (tx) => {
      if ((await update(tx)).count === 0) return false;
      const rolledUp = await db.notifications.rollUp(
        tx,
        notification.id,
        notification.createdAt
      );
      await emitTx(tx, {
        organizationId:
          notification.organizationId ?? getDefaultOrganizationId(),
        eventType: `notification.${status}`,
        entityType: "Notification",
        entityId: notification.id,
        data: {
          id: notification.id,
          channel: notification.channel,
          deliveryId,
          status: rolledUp,
          connection: connectionSlug,
        },
      });
      return true;
    });

  // A delivery the stale sweep put back after its last attempt has none left.
  if (delivery.attempts >= NOTIFICATION_DELIVERY_ATTEMPTS) {
    const lastError = delivery.lastError ?? "attempts_exhausted";
    const used = delivery.connectionId
      ? await prisma.notificationConnection.findUnique({
          where: { id: delivery.connectionId },
          select: { slug: true },
        })
      : null;
    await settle("failed", used?.slug ?? null, (tx) =>
      db.notifications.markFailed(tx, ref, lastError, "pending")
    );
    logger.warn(
      { deliveryId, notificationId, attempts: delivery.attempts, lastError },
      "Notification delivery failed: no attempts left"
    );
    return;
  }

  // Nothing is sent or claimed before `markSending`, so a failure up to there
  // (the database or Redis briefly away) delays the job rather than spending
  // one of its attempts on a send that never started.
  let connection: NotificationConnection | null;
  try {
    connection = await resolveConnection(
      notification.channel,
      notification.connectionId
    );
    if (!connection) {
      await db.notifications.markPending(ref, "no_connection", "pending");
      return await delay(job, token, NO_CONNECTION_DELAY_MS);
    }
    const wait = await takeSendToken(connection.id, connection.maxPerMinute);
    if (wait > 0) return await delay(job, token, wait);

    if (!(await db.notifications.markSending(ref, connection.id))) return;
  } catch (err) {
    if (err instanceof DelayedError) throw err;
    // A failure that keeps happening (not a blip) falls through to the job's
    // attempts, so the delivery fails in the end rather than waiting forever.
    const delays = (job.data.preClaimDelays ?? 0) + 1;
    if (delays > MAX_PRE_CLAIM_DELAYS) throw err;
    logger.warn(
      { err, deliveryId, notificationId, delays },
      "Notification delivery could not start; delaying it"
    );
    await job.updateData({ ...job.data, preClaimDelays: delays });
    return delay(job, token, PRE_CLAIM_RETRY_MS);
  }
  const attempt = delivery.attempts + 1;

  let result: SendResult;
  try {
    const view = toConnectionView(connection);
    const parsed = adapter.contentSchema.safeParse(notification.content);
    if (!parsed.success) {
      throw new PermanentSendError("invalid_content", "No content to send");
    }
    const content = parsed.data;
    // Checked again: the default may have changed since accept, and a sender
    // allowed there may not be here. Never sent from another address instead.
    adapter.validate(view, content);
    const secrets = await openConnectionSecrets(connection);
    const stored = delivery.recipients as unknown as StoredRecipient[];
    const attachments =
      notification.attachments as unknown as StoredAttachment[];
    await assertAttachmentsReadable(notification, attachments);
    result = await adapter.send({
      deliveryId,
      connection: view,
      secrets,
      content,
      recipients: stored.map(toResolvedRecipient),
      attachments: attachments.map(toAttachmentStream),
    });
  } catch (err) {
    const lastError = describeFailure(err);
    const permanent =
      err instanceof PermanentSendError || err instanceof BadRequestError;
    const exhausted =
      attempt >= NOTIFICATION_DELIVERY_ATTEMPTS ||
      job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (!permanent && !exhausted) {
      await db.notifications.markPending(ref, lastError, "sending");
      throw err;
    }
    const settled =
      (await settle("failed", connection.slug, (tx) =>
        db.notifications.markFailed(tx, ref, lastError)
      )) ||
      // The stale sweep put the delivery back to `pending` while this send
      // ran, and its re-queue was a no-op while this job was active: no other
      // attempt is coming, so this one records the failure.
      (await settle("failed", connection.slug, (tx) =>
        db.notifications.markFailed(tx, ref, lastError, "pending")
      ));
    logger.warn(
      { deliveryId, notificationId, attempt, lastError },
      settled
        ? "Notification delivery failed"
        : "Notification delivery failed, but it was already settled or claimed again"
    );
    return;
  }

  // Outside the try: once sent, a failure here must not mark it failed. The
  // write is retried here first, since a retry of the job would find the
  // delivery `sending` and leave it to the stale sweep, which sends it again.
  for (let tries = 1; ; tries++) {
    try {
      if (
        await settle("sent", connection.slug, (tx) =>
          db.notifications.markSent(tx, ref, result)
        )
      ) {
        return;
      }
      // The stale sweep put the delivery back to `pending` while this send
      // ran. It went out, so record it before the re-queued job sends it again.
      const recorded = await settle("sent", connection.slug, (tx) =>
        db.notifications.markSent(tx, ref, result, "pending")
      );
      logger.warn(
        {
          deliveryId,
          notificationId,
          providerMessageId: result.providerMessageId,
        },
        recorded
          ? "Notification sent after the stale sweep reset it; recorded as sent"
          : "Notification sent after the stale sweep reset it; already claimed again, so it may be sent twice"
      );
      return;
    } catch (err) {
      if (tries >= RECORD_SENT_TRIES) {
        logger.error(
          {
            err,
            deliveryId,
            notificationId,
            providerMessageId: result.providerMessageId,
          },
          "Notification sent but not recorded; the stale sweep will send it again"
        );
        throw err;
      }
      await sleep(RECORD_SENT_BACKOFF_MS * tries);
    }
  }
}

export async function startNotificationDeliveryWorker(): Promise<void> {
  workers = CHANNELS.map((channel) => {
    const worker = new TrackedWorker<NotificationDeliveryJobData>(
      notificationQueueName(channel),
      (job, token) => processNotificationDelivery(job, token),
      { connection: getRedisClient().duplicate(), concurrency: 10 }
    );
    worker.on("failed", (job, err) => {
      logger.error(
        { jobId: job?.id, deliveryId: job?.data.deliveryId, err },
        "Notification delivery job failed"
      );
    });
    return worker;
  });
  logger.info({ channels: CHANNELS }, "Notification delivery worker started");
}

export async function stopNotificationDeliveryWorker(): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
  workers = [];
}
