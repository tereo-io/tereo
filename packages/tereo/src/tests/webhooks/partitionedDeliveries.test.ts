import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import axios from "axios";
import {
  closeWebhookQueues,
  enqueueWebhookDelivery,
  getWebhookDeliveryQueue,
} from "../../jobs/webhookQueues.js";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  createTestWebhookEndpoint,
  cleanupTestEntities,
} from "../support/webhooks.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const dayStr = (date: Date) => date.toISOString().split("T")[0];
const partitionName = (date: Date) =>
  `webhook_deliveries_${dayStr(date).replaceAll("-", "_")}`;

describe("Deliveries on the partitioned table", () => {
  let token: string;
  const jobIds: string[] = [];
  const createdPartitions: string[] = [];

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    const queue = getWebhookDeliveryQueue();
    for (const id of jobIds) await queue.remove(id).catch(() => {});
    await closeWebhookQueues();
    await cleanupTestEntities();
    for (const name of createdPartitions) {
      await db.webhookDeliveries.dropPartition(name).catch(() => {});
    }
  });

  /** A delivery to `endpointId` created `daysAgo` days ago, partition and all. */
  const deliveryCreated = async (
    endpointId: string,
    eventType: string,
    daysAgo: number,
    status: "PENDING" | "SUCCESS" | "FAILED" = "SUCCESS"
  ) => {
    const createdAt = new Date(Date.now() - daysAgo * DAY_MS);
    const name = partitionName(createdAt);
    const existing = await db.webhookDeliveries.listPartitions();
    if (!existing.some((p) => p.child === name)) {
      const start = new Date(`${dayStr(createdAt)}T00:00:00Z`);
      await db.webhookDeliveries.createPartition(
        name,
        dayStr(start),
        dayStr(new Date(start.getTime() + DAY_MS))
      );
      createdPartitions.push(name);
    }
    return prisma.webhookDelivery.create({
      data: {
        webhookEndpointId: endpointId,
        eventType,
        payload: { daysAgo },
        status,
        attempts: status === "PENDING" ? 0 : 1,
        completedAt: status === "PENDING" ? null : createdAt,
        createdAt,
      },
    });
  };

  describe("stats", () => {
    it("count only the deliveries of the last 30 days", async () => {
      const ep = await createTestWebhookEndpoint(token);
      const [eventType] = ep.eventTypes;
      await deliveryCreated(ep.id, eventType, 0, "SUCCESS");
      await deliveryCreated(ep.id, eventType, 10, "FAILED");
      const old = await deliveryCreated(ep.id, eventType, 40, "FAILED");

      const response = await axios.get(`${BASE_URL}/webhooks/${ep.id}/stats`, {
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data).toMatchObject({
        windowDays: 30,
        total: 2,
        success: 1,
        failed: 1,
        pending: 0,
        successRate: 0.5,
        averageAttempts: 1,
        last24Hours: { total: 1, success: 1, failed: 0, pending: 0 },
      });
      // Still listed: the window bounds the stats, not the history.
      const listed = await axios.get(
        `${BASE_URL}/webhooks/${ep.id}/deliveries?limit=10`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(listed.data.data.map((d: { id: string }) => d.id)).toContain(
        old.id
      );
    });
  });

  describe("lookup by id", () => {
    it("finds a delivery with its createdAt, and without it", async () => {
      const ep = await createTestWebhookEndpoint(token);
      const delivery = await deliveryCreated(ep.id, ep.eventTypes[0], 3);

      expect(
        (await db.webhookDeliveries.findById(delivery.id, delivery.createdAt))
          ?.id
      ).toBe(delivery.id);
      expect((await db.webhookDeliveries.findById(delivery.id))?.id).toBe(
        delivery.id
      );
    });

    it("falls back to the id alone when the createdAt given is wrong", async () => {
      const ep = await createTestWebhookEndpoint(token);
      const delivery = await deliveryCreated(ep.id, ep.eventTypes[0], 0);
      const wrong = new Date(delivery.createdAt.getTime() - 5 * DAY_MS);

      expect(
        (await db.webhookDeliveries.findById(delivery.id, wrong))?.id
      ).toBe(delivery.id);
    });

    it("puts the createdAt in the job, as the bulk retry returns it", async () => {
      const ep = await createTestWebhookEndpoint(token);
      const delivery = await deliveryCreated(
        ep.id,
        ep.eventTypes[0],
        2,
        "FAILED"
      );

      const [reset] = await db.webhookDeliveries.bulkResetForRetry(ep.id, {
        limit: 10,
      });
      expect(reset.id).toBe(delivery.id);
      expect(reset.createdAt.toISOString()).toBe(
        delivery.createdAt.toISOString()
      );

      jobIds.push(delivery.id);
      expect(await enqueueWebhookDelivery(reset)).toBe(true);
      const job = await getWebhookDeliveryQueue().getJob(delivery.id);
      expect(job?.data).toEqual({
        deliveryId: delivery.id,
        createdAt: delivery.createdAt.toISOString(),
      });
    });
  });
});
