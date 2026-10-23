// @module-tag int
// @module-tag webhooks
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  getTestOrgId,
  createTestEventType,
  createTestWebhookEndpoint,
  cleanupTestEntities,
  generateUniqueId,
  emitTestEvent,
  WebhookDeliveryResponse,
  PaginatedResponse,
  seedDeliveries,
} from "../../../../../../support/webhooks.js";

const get = <T>(path: string, token: string, headers = {}) =>
  axios.get<T>(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}`, ...headers },
    validateStatus: () => true,
  });

describe("GET /v1/webhooks/webhooks/:id/deliveries and POST /v1/webhooks/webhooks/:id/deliveries/retry", () => {
  describe("Webhook Deliveries", () => {
    let testToken: string;
    let endpointId: string;
    let eventTypeName: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();

      // Set up: an event type and endpoint with delivery records
      const seeded = await seedDeliveries(testToken, 2);
      eventTypeName = seeded.eventType;
      endpointId = seeded.endpointId;
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("GET /webhooks/:id/deliveries", () => {
      it("should list deliveries for a webhook endpoint", async () => {
        const response = await axios.get<
          PaginatedResponse<WebhookDeliveryResponse>
        >(`${BASE_URL}/webhooks/${endpointId}/deliveries`, {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.data).toBeDefined();
        expect(Array.isArray(response.data.data)).toBe(true);
        expect(response.data.data.length).toBeGreaterThanOrEqual(2);

        const delivery = response.data.data[0];
        expect(delivery.id).toBeDefined();
        expect(delivery.webhookEndpointId).toBe(endpointId);
        expect(delivery.eventType).toBe(eventTypeName);
        expect(delivery.status).toBeDefined();
        expect(delivery.payload).toBeDefined();
        expect(delivery.createdAt).toBeDefined();
      });

      it("should support pagination", async () => {
        const response = await axios.get<
          PaginatedResponse<WebhookDeliveryResponse>
        >(`${BASE_URL}/webhooks/${endpointId}/deliveries?limit=1`, {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.data.length).toBeLessThanOrEqual(1);
        expect(response.data.hasMore).toBe(true);
      });

      it("should round-trip nextCursor for a second page of deliveries", async () => {
        const page1 = await axios.get<
          PaginatedResponse<WebhookDeliveryResponse>
        >(`${BASE_URL}/webhooks/${endpointId}/deliveries?limit=1`, {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });

        expect(page1.status).toBe(HTTP_STATUS.OK);
        expect(page1.data.data.length).toBe(1);
        expect(page1.data.hasMore).toBe(true);
        expect(page1.data.nextCursor).toBeDefined();
        expect(page1.data.nextCursor).not.toBeNull();

        const page2 = await axios.get<
          PaginatedResponse<WebhookDeliveryResponse>
        >(
          `${BASE_URL}/webhooks/${endpointId}/deliveries?limit=1&cursor=${encodeURIComponent(
            page1.data.nextCursor!
          )}`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(page2.status).toBe(HTTP_STATUS.OK);
        expect(page2.data.data.length).toBeGreaterThan(0);
        // Page 2 row(s) must not be the same as page 1
        const page1Ids = new Set(page1.data.data.map((d) => d.id));
        for (const d of page2.data.data) {
          expect(page1Ids.has(d.id)).toBe(false);
        }
      });

      it("should filter by status", async () => {
        const response = await axios.get<
          PaginatedResponse<WebhookDeliveryResponse>
        >(
          `${BASE_URL}/webhooks/${endpointId}/deliveries?filter[status]=PENDING`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        for (const delivery of response.data.data) {
          expect(delivery.status).toBe("PENDING");
        }
      });

      it("should filter by eventType", async () => {
        const response = await axios.get<
          PaginatedResponse<WebhookDeliveryResponse>
        >(
          `${BASE_URL}/webhooks/${endpointId}/deliveries?filter[eventType]=${eventTypeName}`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        for (const delivery of response.data.data) {
          expect(delivery.eventType).toBe(eventTypeName);
        }
      });
    });

    describe("POST /webhooks/:id/deliveries/retry (Bulk Retry)", () => {
      it("should bulk retry FAILED deliveries and return count", async () => {
        const et = await createTestEventType(testToken);
        const ep = await createTestWebhookEndpoint(testToken, {
          eventTypes: [et.eventType],
        });

        // Emit multiple events and mark them as FAILED
        await emitTestEvent(testToken, { eventType: et.eventType });
        await emitTestEvent(testToken, { eventType: et.eventType });
        await emitTestEvent(testToken, { eventType: et.eventType });

        await prisma.webhookDelivery.updateMany({
          where: { webhookEndpointId: ep.id },
          data: {
            status: "FAILED",
            attempts: 10,
            errorMessage: "HTTP 500",
            completedAt: new Date(),
          },
        });

        const response = await axios.post(
          `${BASE_URL}/webhooks/${ep.id}/deliveries/retry`,
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
        expect(response.data.retriedCount).toBe(3);

        // Verify deliveries were reset
        const deliveries = await prisma.webhookDelivery.findMany({
          where: { webhookEndpointId: ep.id },
        });
        for (const d of deliveries) {
          expect(d.status).toBe("PENDING");
          expect(d.attempts).toBe(0);
          expect(d.errorMessage).toBeNull();
        }
      });

      it("should filter by eventType", async () => {
        const et1 = await createTestEventType(testToken);
        const et2 = await createTestEventType(testToken);
        const ep = await createTestWebhookEndpoint(testToken, {
          eventTypes: [et1.eventType, et2.eventType],
        });

        await emitTestEvent(testToken, { eventType: et1.eventType });
        await emitTestEvent(testToken, { eventType: et2.eventType });

        await prisma.webhookDelivery.updateMany({
          where: { webhookEndpointId: ep.id },
          data: {
            status: "FAILED",
            attempts: 10,
            errorMessage: "HTTP 500",
            completedAt: new Date(),
          },
        });

        const response = await axios.post(
          `${BASE_URL}/webhooks/${ep.id}/deliveries/retry`,
          { eventType: et1.eventType },
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.ACCEPTED);
        expect(response.data.retriedCount).toBe(1);
      });

      it("should skip non-FAILED deliveries", async () => {
        const et = await createTestEventType(testToken);
        const ep = await createTestWebhookEndpoint(testToken, {
          eventTypes: [et.eventType],
        });

        // Create deliveries that are PENDING (not FAILED)
        await emitTestEvent(testToken, { eventType: et.eventType });
        await emitTestEvent(testToken, { eventType: et.eventType });

        const response = await axios.post(
          `${BASE_URL}/webhooks/${ep.id}/deliveries/retry`,
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
        expect(response.data.retriedCount).toBe(0);
      });

      it("should filter by date range", async () => {
        const et = await createTestEventType(testToken);
        const ep = await createTestWebhookEndpoint(testToken, {
          eventTypes: [et.eventType],
        });

        await emitTestEvent(testToken, { eventType: et.eventType });

        await prisma.webhookDelivery.updateMany({
          where: { webhookEndpointId: ep.id },
          data: {
            status: "FAILED",
            attempts: 10,
            errorMessage: "HTTP 500",
            completedAt: new Date(),
          },
        });

        // Use a future date range that excludes all deliveries
        const futureDate = new Date(Date.now() + 86400000).toISOString();

        const response = await axios.post(
          `${BASE_URL}/webhooks/${ep.id}/deliveries/retry`,
          { createdAfter: futureDate },
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.ACCEPTED);
        expect(response.data.retriedCount).toBe(0);
      });
    });
  });

  describe("Webhook list filters and fields", () => {
    let token: string;

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("GET /webhooks/:id/deliveries — createdAt range", () => {
      let endpointId: string;
      let before: Date;

      beforeAll(async () => {
        const et = await createTestEventType(token);
        const ep = await createTestWebhookEndpoint(token, {
          eventTypes: [et.eventType],
        });
        endpointId = ep.id;
        before = new Date(Date.now() - 60_000);
        const emitted = await axios.post(
          `${BASE_URL}/events`,
          {
            organizationId: getTestOrgId(),
            eventType: et.eventType,
            entityType: "TestEntity",
            entityId: `test-entity-${generateUniqueId()}`,
            data: {},
          },
          { headers: { Authorization: `Bearer ${token}` } }
        );
        expect(emitted.status).toBe(HTTP_STATUS.ACCEPTED);
      });

      const deliveries = (query: string) =>
        get<PaginatedResponse<WebhookDeliveryResponse>>(
          `/webhooks/${endpointId}/deliveries?${query}`,
          token
        );

      it("includes deliveries inside the window", async () => {
        const after = new Date(Date.now() + 60_000);
        const res = await deliveries(
          `filter[createdAt_gte]=${before.toISOString()}&filter[createdAt_lte]=${after.toISOString()}`
        );
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(res.data.data.length).toBe(1);
      });

      it("excludes deliveries outside the window", async () => {
        const later = await deliveries(
          `filter[createdAt_gte]=${new Date(Date.now() + 3_600_000).toISOString()}`
        );
        expect(later.status).toBe(HTTP_STATUS.OK);
        expect(later.data.data).toEqual([]);

        const earlier = await deliveries(
          `filter[createdAt_lte]=${before.toISOString()}`
        );
        expect(earlier.status).toBe(HTTP_STATUS.OK);
        expect(earlier.data.data).toEqual([]);
      });
    });
  });
});
