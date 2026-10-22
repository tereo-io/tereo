// @module-tag int
// @module-tag webhooks
import { HEADER_VALUE_MASK } from "../../../../../../utils/webhookHeaders.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import {} from "../../../../../../jobs/webhookQueues.js";
import db from "../../../../../../utils/db/index.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  createTestEventType,
  createTestWebhookEndpoint,
  cleanupTestEntities,
  emitTestEvent,
  generateUniqueId,
  WebhookEndpointResponse,
  PaginatedResponse,
} from "../../../../../support/webhooks.js";

const MASK = HEADER_VALUE_MASK;

const DAY_MS = 24 * 60 * 60 * 1000;

const dayStr = (date: Date) => date.toISOString().split("T")[0];
const partitionName = (date: Date) =>
  `webhook_deliveries_${dayStr(date).replaceAll("-", "_")}`;

describe("GET /v1/webhooks/webhooks/:id and GET /v1/webhooks/webhooks/:id/stats", () => {
  describe("Webhook Endpoint Management", () => {
    let testToken: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("GET /webhooks/:id", () => {
      it("should get webhook endpoint by ID with masked secret", async () => {
        const ep = await createTestWebhookEndpoint(testToken);

        const response = await axios.get<WebhookEndpointResponse>(
          `${BASE_URL}/webhooks/${ep.id}`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.id).toBe(ep.id);
        expect(response.data.url).toBe(ep.url);
        // Secret should be masked on GET
        expect(response.data.signingSecret).toContain("...");
      });

      it("should return 404 for non-existent endpoint", async () => {
        const response = await axios.get(
          `${BASE_URL}/webhooks/00000000-0000-0000-0000-000000000000`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      });
    });

    describe("Custom Headers", () => {
      it("should return masked custom headers in GET response", async () => {
        const et = await createTestEventType(testToken);
        const uniqueId = generateUniqueId();

        const createResponse = await axios.post<WebhookEndpointResponse>(
          `${BASE_URL}/webhooks`,
          {
            url: `https://example.com/webhook/${uniqueId}`,
            eventTypes: [et.eventType],
            customHeaders: { "X-Api-Key": "test-key" },
          },
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        const getResponse = await axios.get<WebhookEndpointResponse>(
          `${BASE_URL}/webhooks/${createResponse.data.id}`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(getResponse.status).toBe(HTTP_STATUS.OK);
        expect(getResponse.data.customHeaders).toEqual({ "X-Api-Key": MASK });

        const listResponse = await axios.get<
          PaginatedResponse<WebhookEndpointResponse>
        >(`${BASE_URL}/webhooks?limit=100`, {
          headers: { Authorization: `Bearer ${testToken}` },
        });
        const listed = listResponse.data.data.find(
          (ep) => ep.id === createResponse.data.id
        );
        expect(listed?.customHeaders).toEqual({ "X-Api-Key": MASK });
      });
    });
  });

  describe("Webhook Deliveries", () => {
    let testToken: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("GET /webhooks/:id/stats", () => {
      it("should return delivery statistics for an endpoint", async () => {
        const et = await createTestEventType(testToken);
        const ep = await createTestWebhookEndpoint(testToken, {
          eventTypes: [et.eventType],
        });

        // Create deliveries with different statuses
        await emitTestEvent(testToken, { eventType: et.eventType });
        await emitTestEvent(testToken, { eventType: et.eventType });
        await emitTestEvent(testToken, { eventType: et.eventType });

        // Mark some as completed
        const deliveries = await prisma.webhookDelivery.findMany({
          where: { webhookEndpointId: ep.id },
          orderBy: { createdAt: "desc" },
        });

        // Mark first as SUCCESS
        await prisma.webhookDelivery.update({
          where: { id: deliveries[0].id },
          data: {
            status: "SUCCESS",
            attempts: 1,
            completedAt: new Date(),
          },
        });

        // Mark second as FAILED
        await prisma.webhookDelivery.update({
          where: { id: deliveries[1].id },
          data: {
            status: "FAILED",
            attempts: 10,
            errorMessage: "HTTP 500",
            completedAt: new Date(),
          },
        });

        // Third stays PENDING

        const response = await axios.get(
          `${BASE_URL}/webhooks/${ep.id}/stats`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.total).toBe(3);
        expect(response.data.success).toBe(1);
        expect(response.data.failed).toBe(1);
        expect(response.data.pending).toBe(1);
        expect(response.data.successRate).toBe(0.5);
        expect(typeof response.data.averageAttempts).toBe("number");
        expect(response.data.last24Hours).toBeDefined();
        expect(response.data.last24Hours.total).toBe(3);
      });

      it("should return zero stats for endpoint with no deliveries", async () => {
        const ep = await createTestWebhookEndpoint(testToken);

        const response = await axios.get(
          `${BASE_URL}/webhooks/${ep.id}/stats`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.total).toBe(0);
        expect(response.data.success).toBe(0);
        expect(response.data.failed).toBe(0);
        expect(response.data.pending).toBe(0);
        expect(response.data.successRate).toBe(0);
        expect(response.data.averageAttempts).toBe(0);
      });
    });
  });

  describe("Deliveries on the partitioned table", () => {
    let token: string;
    const createdPartitions: string[] = [];

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    afterAll(async () => {
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

        const response = await axios.get(
          `${BASE_URL}/webhooks/${ep.id}/stats`,
          {
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
          }
        );

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
  });

  describe("Webhook signing secret rotation", () => {
    let token: string;

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    const getEndpoint = (id: string) =>
      axios.get<WebhookEndpointResponse & Record<string, unknown>>(
        `${BASE_URL}/webhooks/${id}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

    describe("hasDeliveries", () => {
      it("is false until a delivery exists, on get and list", async () => {
        const et = await createTestEventType(token);
        const ep = await createTestWebhookEndpoint(token, {
          eventTypes: [et.eventType],
        });
        expect(ep.hasDeliveries).toBe(false);
        expect((await getEndpoint(ep.id)).data.hasDeliveries).toBe(false);

        const emitted = await emitTestEvent(token, { eventType: et.eventType });
        expect(emitted.deliveriesCreated).toBe(1);

        expect((await getEndpoint(ep.id)).data.hasDeliveries).toBe(true);

        const list = await axios.get<
          PaginatedResponse<WebhookEndpointResponse>
        >(
          `${BASE_URL}/webhooks?filter[url]=${encodeURIComponent(ep.url)}&filter[url_op]=contains`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const listed = list.data.data.find((e) => e.id === ep.id);
        expect(listed?.hasDeliveries).toBe(true);
      });
    });
  });
});
