import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureDailyPartitions } from "../../utils/partitions.js";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import {
  ATTEMPTED_STALE_MS,
  LONGEST_BACKOFF_MS,
  processStaleDeliveries,
} from "../../jobs/staleDeliverySweep.js";
import {
  closeWebhookQueues,
  enqueueWebhookDelivery,
  getWebhookDeliveryQueue,
} from "../../jobs/webhookQueues.js";
import {
  getTestAccessToken,
  createTestWebhookEndpoint,
  cleanupTestEntities,
} from "../support/webhooks.js";

const STALE_AFTER_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// The delivery worker does not run under test, so queued jobs stay waiting
// and the queue can be inspected.
describe("Stale delivery sweep", () => {
  let token: string;
  const jobIds: string[] = [];

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    const queue = getWebhookDeliveryQueue();
    for (const id of jobIds) await queue.remove(id).catch(() => {});
    await closeWebhookQueues();
    await cleanupTestEntities();
  });

  /** A delivery written without a job, as when Redis is down at commit. */
  const pendingDelivery = async (ageMs = 0) => {
    const ep = await createTestWebhookEndpoint(token);
    const delivery = await db.webhookDeliveries.create({
      webhookEndpointId: ep.id,
      eventType: ep.eventTypes[0],
      payload: { id: crypto.randomUUID(), eventType: ep.eventTypes[0] },
    });
    jobIds.push(delivery.id);
    if (ageMs > 0) {
      await prisma.$executeRaw`
        UPDATE "webhooks"."webhook_deliveries"
        SET "updated_at" = ${new Date(Date.now() - ageMs)}
        WHERE "id" = ${delivery.id}::uuid`;
    }
    return delivery;
  };

  const sweep = () => processStaleDeliveries({ staleAfterMs: STALE_AFTER_MS });

  it("queues a pending delivery that was never queued", async () => {
    const delivery = await pendingDelivery(STALE_AFTER_MS + 60_000);
    const queue = getWebhookDeliveryQueue();
    expect(await queue.getJob(delivery.id)).toBeUndefined();

    const requeued = await sweep();

    expect(requeued).toContain(delivery.id);
    const job = await queue.getJob(delivery.id);
    expect(job?.data).toMatchObject({ deliveryId: delivery.id });
    expect(await job?.getState()).toBe("waiting");
  });

  it("leaves a delivery that is still fresh", async () => {
    const delivery = await pendingDelivery();

    const requeued = await sweep();

    expect(requeued).not.toContain(delivery.id);
    expect(await getWebhookDeliveryQueue().getJob(delivery.id)).toBeUndefined();
  });

  it("leaves a stale delivery that already has a live job", async () => {
    const delivery = await pendingDelivery(STALE_AFTER_MS + 60_000);
    expect(await enqueueWebhookDelivery(delivery)).toBe(true);
    const queue = getWebhookDeliveryQueue();
    const before = await queue.getJob(delivery.id);

    const requeued = await sweep();

    expect(requeued).not.toContain(delivery.id);
    const after = await queue.getJob(delivery.id);
    expect(after?.timestamp).toBe(before?.timestamp);
  });

  it("leaves a stale delivery that is no longer pending", async () => {
    const delivery = await pendingDelivery();
    await db.webhookDeliveries.updateAttempt(delivery, {
      attempts: 1,
      lastAttemptAt: new Date(),
      status: "SUCCESS",
      completedAt: new Date(),
    });
    await prisma.$executeRaw`
      UPDATE "webhooks"."webhook_deliveries"
      SET "updated_at" = ${new Date(Date.now() - STALE_AFTER_MS - 60_000)}
      WHERE "id" = ${delivery.id}::uuid`;

    const requeued = await sweep();

    expect(requeued).not.toContain(delivery.id);
    expect(await getWebhookDeliveryQueue().getJob(delivery.id)).toBeUndefined();
  });

  /** A pending delivery last attempted `ageMs` ago, as one in backoff. */
  const attemptedDelivery = async (ageMs: number) => {
    const delivery = await pendingDelivery();
    const at = new Date(Date.now() - ageMs);
    await prisma.$executeRaw`
      UPDATE "webhooks"."webhook_deliveries"
      SET "attempts" = 3, "last_attempt_at" = ${at}, "updated_at" = ${at}
      WHERE "id" = ${delivery.id}::uuid`;
    return delivery;
  };

  it("leaves an attempted delivery that may be waiting out its backoff", async () => {
    const delivery = await attemptedDelivery(LONGEST_BACKOFF_MS);

    const requeued = await sweep();

    expect(requeued).not.toContain(delivery.id);
    expect(await getWebhookDeliveryQueue().getJob(delivery.id)).toBeUndefined();
  });

  it("re-queues an attempted delivery idle past any backoff", async () => {
    const delivery = await attemptedDelivery(ATTEMPTED_STALE_MS + 60_000);

    const requeued = await sweep();

    expect(requeued).toContain(delivery.id);
    const job = await getWebhookDeliveryQueue().getJob(delivery.id);
    expect(await job?.getState()).toBe("waiting");
  });

  it("queues a retried delivery whose enqueue failed, however old the delivery", async () => {
    await ensureDailyPartitions("webhooks", -30, -30);
    const delivery = await pendingDelivery();
    const createdAt = new Date(Date.now() - 30 * DAY_MS);
    // A retry resets a FAILED delivery to PENDING and clears its attempts.
    await prisma.$executeRaw`
      UPDATE "webhooks"."webhook_deliveries"
      SET "created_at" = ${createdAt}, "attempts" = 0, "last_attempt_at" = NULL,
          "updated_at" = ${new Date(Date.now() - STALE_AFTER_MS - 60_000)}
      WHERE "id" = ${delivery.id}::uuid`;

    const requeued = await sweep();

    expect(requeued).toContain(delivery.id);
    const job = await getWebhookDeliveryQueue().getJob(delivery.id);
    expect(job?.data).toMatchObject({ deliveryId: delivery.id });
  });

  it("waits longer for an attempted delivery than any backoff", () => {
    expect(ATTEMPTED_STALE_MS).toBeGreaterThan(LONGEST_BACKOFF_MS);
  });

  it("does not add a second job when a delivery is enqueued twice", async () => {
    const delivery = await pendingDelivery();

    expect(await enqueueWebhookDelivery(delivery)).toBe(true);
    expect(await enqueueWebhookDelivery(delivery)).toBe(false);
  });
});
