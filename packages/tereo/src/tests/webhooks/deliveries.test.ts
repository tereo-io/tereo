import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
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
} from "./utils/test-helpers.js";

describe("Webhook Deliveries", () => {
  let testToken: string;
  let endpointId: string;
  let eventTypeName: string;

  beforeAll(async () => {
    testToken = await getTestAccessToken();

    // Set up: create an event type and endpoint, then emit an event to generate deliveries
    const et = await createTestEventType(testToken);
    eventTypeName = et.eventType;

    const ep = await createTestWebhookEndpoint(testToken, {
      eventTypes: [et.eventType],
    });
    endpointId = ep.id;

    // Emit events to generate delivery records
    await axios.post(
      `${BASE_URL}/events`,
      {
        organizationId: getTestOrgId(),
        eventType: et.eventType,
        entityType: "TestEntity",
        entityId: `test-entity-${generateUniqueId()}`,
        data: { key: "value1" },
      },
      {
        headers: {
          Authorization: `Bearer ${testToken}`,
          "Content-Type": "application/json",
        },
        validateStatus: () => true,
      }
    );

    await axios.post(
      `${BASE_URL}/events`,
      {
        organizationId: getTestOrgId(),
        eventType: et.eventType,
        entityType: "TestEntity",
        entityId: `test-entity-${generateUniqueId()}`,
        data: { key: "value2" },
      },
      {
        headers: {
          Authorization: `Bearer ${testToken}`,
          "Content-Type": "application/json",
        },
        validateStatus: () => true,
      }
    );
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
      const page1 = await axios.get<PaginatedResponse<WebhookDeliveryResponse>>(
        `${BASE_URL}/webhooks/${endpointId}/deliveries?limit=1`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(page1.status).toBe(HTTP_STATUS.OK);
      expect(page1.data.data.length).toBe(1);
      expect(page1.data.hasMore).toBe(true);
      expect(page1.data.nextCursor).toBeDefined();
      expect(page1.data.nextCursor).not.toBeNull();

      const page2 = await axios.get<PaginatedResponse<WebhookDeliveryResponse>>(
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

    it("refuses a cursor minted for another endpoint's deliveries", async () => {
      const auth = {
        headers: { Authorization: `Bearer ${testToken}` },
        validateStatus: () => true,
      };
      const page1 = await axios.get(
        `${BASE_URL}/webhooks/${endpointId}/deliveries?limit=1`,
        auth
      );
      expect(page1.data.nextCursor).toBeTruthy();
      const cursor = encodeURIComponent(page1.data.nextCursor);

      const other = await createTestWebhookEndpoint(testToken, {
        eventTypes: [eventTypeName],
      });
      const replayed = await axios.get(
        `${BASE_URL}/webhooks/${other.id}/deliveries?limit=1&cursor=${cursor}`,
        auth
      );
      expect(replayed.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(replayed.data.error).toBe("invalid_cursor");

      // Same sort (createdAt desc), different list.
      const endpoints = await axios.get(
        `${BASE_URL}/webhooks?limit=1&cursor=${cursor}`,
        auth
      );
      expect(endpoints.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(endpoints.data.error).toBe("invalid_cursor");
    });

    it("should return 400 for an invalid/tampered cursor", async () => {
      const response = await axios.get(
        `${BASE_URL}/webhooks/${endpointId}/deliveries?cursor=not-a-real-cursor`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(response.data.error).toBe("invalid_cursor");
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

    it("should return 404 for endpoint belonging to different client", async () => {
      const otherToken = await getTestAccessToken(
        "00000000-0000-7001-0000-000000000002",
        "other-org-1"
      );

      const response = await axios.get(
        `${BASE_URL}/webhooks/${endpointId}/deliveries`,
        {
          headers: { Authorization: `Bearer ${otherToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });
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

    it("should return 404 for endpoint belonging to different client", async () => {
      // Get a valid delivery ID first
      const deliveries = await prisma.webhookDelivery.findMany({
        where: { webhookEndpointId: endpointId },
        take: 1,
      });
      const deliveryId = deliveries[0].id;

      const otherToken = await getTestAccessToken(
        "00000000-0000-7001-0000-000000000002",
        "other-org-1"
      );

      const response = await axios.get(
        `${BASE_URL}/webhooks/${endpointId}/deliveries/${deliveryId}`,
        {
          headers: { Authorization: `Bearer ${otherToken}` },
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

    it("should return 400 when retrying a PENDING delivery", async () => {
      // Find a PENDING delivery from the setup
      const deliveries = await prisma.webhookDelivery.findMany({
        where: { webhookEndpointId: endpointId, status: "PENDING" },
        take: 1,
      });
      const deliveryId = deliveries[0].id;

      const response = await axios.post(
        `${BASE_URL}/webhooks/${endpointId}/deliveries/${deliveryId}/retry`,
        {},
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should return 404 for cross-tenant retry", async () => {
      const deliveries = await prisma.webhookDelivery.findMany({
        where: { webhookEndpointId: endpointId },
        take: 1,
      });
      const deliveryId = deliveries[0].id;

      const otherToken = await getTestAccessToken(
        "00000000-0000-7001-0000-000000000002",
        "other-org-1"
      );

      const response = await axios.post(
        `${BASE_URL}/webhooks/${endpointId}/deliveries/${deliveryId}/retry`,
        {},
        {
          headers: {
            Authorization: `Bearer ${otherToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
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

    it("should respect limit parameter", async () => {
      const et = await createTestEventType(testToken);
      const ep = await createTestWebhookEndpoint(testToken, {
        eventTypes: [et.eventType],
      });

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
        { limit: 2 },
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.ACCEPTED);
      expect(response.data.retriedCount).toBe(2);
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

    it("should return 404 for cross-tenant bulk retry", async () => {
      const otherToken = await getTestAccessToken(
        "00000000-0000-7001-0000-000000000002",
        "other-org-1"
      );

      const response = await axios.post(
        `${BASE_URL}/webhooks/${endpointId}/deliveries/retry`,
        {},
        {
          headers: {
            Authorization: `Bearer ${otherToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
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

      const response = await axios.get(`${BASE_URL}/webhooks/${ep.id}/stats`, {
        headers: { Authorization: `Bearer ${testToken}` },
        validateStatus: () => true,
      });

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

      const response = await axios.get(`${BASE_URL}/webhooks/${ep.id}/stats`, {
        headers: { Authorization: `Bearer ${testToken}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.total).toBe(0);
      expect(response.data.success).toBe(0);
      expect(response.data.failed).toBe(0);
      expect(response.data.pending).toBe(0);
      expect(response.data.successRate).toBe(0);
      expect(response.data.averageAttempts).toBe(0);
    });

    it("should return 404 for cross-tenant stats", async () => {
      const otherToken = await getTestAccessToken(
        "00000000-0000-7001-0000-000000000002",
        "other-org-1"
      );

      const response = await axios.get(
        `${BASE_URL}/webhooks/${endpointId}/stats`,
        {
          headers: { Authorization: `Bearer ${otherToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });
  });

  describe("malformed input", () => {
    const call = (method: "get" | "post", path: string, data?: unknown) =>
      axios.request({
        method,
        url: `${BASE_URL}${path}`,
        data,
        headers: { Authorization: `Bearer ${testToken}` },
        validateStatus: () => true,
      });

    it("returns 400 for a non-uuid endpoint id", async () => {
      for (const [method, path] of [
        ["get", "/webhooks/not-a-uuid/deliveries"],
        ["post", "/webhooks/not-a-uuid/deliveries/retry"],
        ["get", `/webhooks/not-a-uuid/deliveries/${crypto.randomUUID()}`],
      ] as const) {
        const response = await call(method, path, {});
        expect(response.status, `${method} ${path}`).toBe(
          HTTP_STATUS.BAD_REQUEST
        );
        expect(response.data.error).toBe("invalid_request");
      }
    });

    it("returns 400 for a non-uuid delivery id", async () => {
      for (const [method, path] of [
        ["get", `/webhooks/${endpointId}/deliveries/not-a-uuid`],
        ["post", `/webhooks/${endpointId}/deliveries/not-a-uuid/retry`],
      ] as const) {
        const response = await call(method, path, {});
        expect(response.status, `${method} ${path}`).toBe(
          HTTP_STATUS.BAD_REQUEST
        );
        expect(response.data.error).toBe("invalid_request");
      }
    });

    it("returns 400 for a fractional bulk-retry limit", async () => {
      const response = await call(
        "post",
        `/webhooks/${endpointId}/deliveries/retry`,
        { limit: 1.5 }
      );
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(response.data.error).toBe("invalid_request");
    });

    it("returns 400 for a bulk-retry limit that is not a JSON number", async () => {
      for (const limit of ["50", true, "1e2"]) {
        const response = await call(
          "post",
          `/webhooks/${endpointId}/deliveries/retry`,
          { limit }
        );
        expect(response.status, JSON.stringify(limit)).toBe(
          HTTP_STATUS.BAD_REQUEST
        );
        expect(response.data.error).toBe("invalid_request");
      }
    });
  });

  describe("retry guards and audit", () => {
    const post = (path: string, data: unknown = {}) =>
      axios.post(`${BASE_URL}${path}`, data, {
        headers: { Authorization: `Bearer ${testToken}` },
        validateStatus: () => true,
      });

    /** An endpoint with `count` FAILED deliveries. */
    const withFailedDeliveries = async (count: number) => {
      const ep = await createTestWebhookEndpoint(testToken);
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const delivery = await prisma.webhookDelivery.create({
          data: {
            webhookEndpointId: ep.id,
            eventType: ep.eventTypes[0],
            payload: { n: i },
            status: "FAILED",
            attempts: 10,
            completedAt: new Date(),
          },
        });
        ids.push(delivery.id);
      }
      return { ep, ids };
    };

    it("resets a delivery once when two retries race", async () => {
      const { ep, ids } = await withFailedDeliveries(1);
      const path = `/webhooks/${ep.id}/deliveries/${ids[0]}/retry`;

      const responses = await Promise.all([post(path), post(path)]);

      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toEqual([HTTP_STATUS.ACCEPTED, HTTP_STATUS.BAD_REQUEST]);
      const rejected = responses.find((r) => r.status === 400)!;
      expect(rejected.data.error).toBe("invalid_delivery_status");
    });

    it("never resets the same delivery in two concurrent bulk retries", async () => {
      const { ep } = await withFailedDeliveries(5);
      const path = `/webhooks/${ep.id}/deliveries/retry`;

      const responses = await Promise.all([post(path), post(path)]);

      expect(responses.map((r) => r.status)).toEqual([202, 202]);
      const total = responses.reduce((n, r) => n + r.data.retriedCount, 0);
      expect(total).toBe(5);
    });

    it("writes an audit entry for a retry and a bulk retry", async () => {
      const { ep, ids } = await withFailedDeliveries(3);

      expect(
        (await post(`/webhooks/${ep.id}/deliveries/${ids[0]}/retry`)).status
      ).toBe(202);
      const bulk = await post(`/webhooks/${ep.id}/deliveries/retry`);
      expect(bulk.data.retriedCount).toBe(2);

      const single = await prisma.auditLogEntry.findFirst({
        where: { entityType: "WebhookDelivery", entityId: ids[0] },
      });
      expect(single?.action).toBe("UPDATE");
      expect(single?.metadata).toMatchObject({
        action: "retry",
        webhookEndpointId: ep.id,
      });
      const many = await prisma.auditLogEntry.findFirst({
        where: {
          entityType: "WebhookEndpoint",
          entityId: ep.id,
          action: "UPDATE",
        },
      });
      expect(many?.metadata).toMatchObject({
        action: "retry-deliveries",
        retriedCount: 2,
      });
    });

    it("returns 400 invalid_endpoint_status for a paused or disabled endpoint", async () => {
      const { ep, ids } = await withFailedDeliveries(1);
      for (const status of ["PAUSED", "DISABLED"] as const) {
        await prisma.webhookEndpoint.update({
          where: { id: ep.id },
          data: { status },
        });
        for (const path of [
          `/webhooks/${ep.id}/deliveries/${ids[0]}/retry`,
          `/webhooks/${ep.id}/deliveries/retry`,
        ]) {
          const response = await post(path);
          expect(response.status, `${status} ${path}`).toBe(400);
          expect(response.data.error).toBe("invalid_endpoint_status");
        }
      }
      const row = await prisma.webhookDelivery.findFirstOrThrow({
        where: { id: ids[0] },
      });
      expect(row.status).toBe("FAILED");
    });
  });
});
