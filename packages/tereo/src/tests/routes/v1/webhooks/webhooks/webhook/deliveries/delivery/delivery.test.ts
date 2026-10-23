// @module-tag int
// @module-tag webhooks
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import db from "../../../../../../../../utils/db/index.js";
import axios from "axios";
import {
  closeWebhookQueues,
  enqueueWebhookDelivery,
  getWebhookDeliveryQueue,
} from "../../../../../../../../jobs/webhookQueues.js";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  createTestEventType,
  createTestWebhookEndpoint,
  cleanupTestEntities,
  emitTestEvent,
  WebhookDeliveryResponse,
  PaginatedResponse,
  seedDeliveries,
} from "../../../../../../../support/webhooks.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const dayStr = (date: Date) => date.toISOString().split("T")[0];
const partitionName = (date: Date) =>
  `webhook_deliveries_${dayStr(date).replaceAll("-", "_")}`;

describe("GET /v1/webhooks/webhooks/:id/deliveries/:deliveryId and POST /v1/webhooks/webhooks/:id/deliveries/:deliveryId/retry", () => {
  describe("Webhook Deliveries", () => {
    let testToken: string;
    let endpointId: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();

      // Set up: an event type and endpoint with delivery records
      ({ endpointId } = await seedDeliveries(testToken, 1));
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("GET /webhooks/:id/deliveries/:deliveryId", () => {
      it("should get a single delivery by ID", async () => {
        // First, get the list to find a delivery ID
        const listResponse = await axios.get<
          PaginatedResponse<WebhookDeliveryResponse>
        >(`${BASE_URL}/webhooks/${endpointId}/deliveries?limit=1`, {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });

        const deliveryId = listResponse.data.data[0].id;

        const response = await axios.get<WebhookDeliveryResponse>(
          `${BASE_URL}/webhooks/${endpointId}/deliveries/${deliveryId}`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.id).toBe(deliveryId);
        expect(response.data.webhookEndpointId).toBe(endpointId);
        expect(response.data.eventType).toBeDefined();
        expect(response.data.payload).toBeDefined();
        expect(response.data.status).toBeDefined();
        expect(response.data.attempts).toBeDefined();
      });

      it("should return 404 for non-existent delivery", async () => {
        const response = await axios.get(
          `${BASE_URL}/webhooks/${endpointId}/deliveries/00000000-0000-0000-0000-000000000000`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      });
    });

    describe("POST /webhooks/:id/deliveries/:deliveryId/retry", () => {
      it("should retry a FAILED delivery and return 202", async () => {
        // Create a delivery via event emission
        const et = await createTestEventType(testToken);
        const ep = await createTestWebhookEndpoint(testToken, {
          eventTypes: [et.eventType],
        });

        await emitTestEvent(testToken, {
          eventType: et.eventType,
        });

        // Find the delivery and manually mark it as FAILED
        const deliveries = await prisma.webhookDelivery.findMany({
          where: { webhookEndpointId: ep.id },
          take: 1,
        });
        const deliveryId = deliveries[0].id;

        await prisma.webhookDelivery.update({
          where: { id: deliveryId },
          data: {
            status: "FAILED",
            attempts: 10,
            errorMessage: "HTTP 500",
            completedAt: new Date(),
          },
        });

        const response = await axios.post(
          `${BASE_URL}/webhooks/${ep.id}/deliveries/${deliveryId}/retry`,
          {},
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.ACCEPTED);
        expect(response.data.status).toBe("PENDING");
        expect(response.data.attempts).toBe(0);
        expect(response.data.errorMessage).toBeNull();
        expect(response.data.httpStatus).toBeNull();
        expect(response.data.responseBody).toBeNull();
        expect(response.data.completedAt).toBeNull();
      });
    });
  });

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
});
