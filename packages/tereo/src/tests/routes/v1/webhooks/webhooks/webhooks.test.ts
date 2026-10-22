// @module-tag int
// @module-tag webhooks
import { HEADER_VALUE_MASK } from "../../../../../utils/webhookHeaders.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../utils/db/prisma.js";
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
  WebhookEndpointResponse,
  PaginatedResponse,
} from "../../../../support/webhooks.js";

const MASK = HEADER_VALUE_MASK;

const get = <T>(path: string, token: string, headers = {}) =>
  axios.get<T>(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}`, ...headers },
    validateStatus: () => true,
  });

const listEndpoints = (query: string, token: string, headers = {}) =>
  get<PaginatedResponse<WebhookEndpointResponse>>(
    `/webhooks?limit=100&${query}`,
    token,
    headers
  );

const ids = (res: { data: { data: { id: string }[] } }) =>
  res.data.data.map((r) => r.id);

describe("GET /v1/webhooks/webhooks and POST /v1/webhooks/webhooks", () => {
  describe("Webhook Endpoint Management", () => {
    let testToken: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("POST /webhooks", () => {
      it("should create a webhook endpoint with valid data", async () => {
        const et = await createTestEventType(testToken);
        const uniqueId = generateUniqueId();

        const response = await axios.post<WebhookEndpointResponse>(
          `${BASE_URL}/webhooks`,
          {
            url: `https://example.com/webhook/${uniqueId}`,
            description: "A test webhook endpoint",
            eventTypes: [et.eventType],
          },
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.CREATED);
        expect(response.data.id).toBeDefined();
        expect(response.data.url).toBe(
          `https://example.com/webhook/${uniqueId}`
        );
        expect(response.data.description).toBe("A test webhook endpoint");
        expect(response.data.status).toBe("ACTIVE");
        expect(response.data.eventTypes).toContain(et.eventType);
        expect(response.data.organizationId).toBe(getTestOrgId());
        expect(response.data.createdAt).toBeDefined();
        // Full signing secret should be returned on create
        expect(response.data.signingSecret).toBeDefined();
        expect(response.data.signingSecret.length).toBeGreaterThan(8);
        expect(response.data.signingSecret).not.toContain("...");
      });
    });

    describe("GET /webhooks", () => {
      it("should list webhook endpoints", async () => {
        await createTestWebhookEndpoint(testToken);

        const response = await axios.get<
          PaginatedResponse<WebhookEndpointResponse>
        >(`${BASE_URL}/webhooks`, {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.data).toBeDefined();
        expect(Array.isArray(response.data.data)).toBe(true);
        expect(response.data.data.length).toBeGreaterThan(0);

        // Verify signing secrets are masked in list response
        const ep = response.data.data[0];
        expect(ep.id).toBeDefined();
        expect(ep.url).toBeDefined();
        expect(ep.signingSecret).toContain("...");
        expect(ep.signingSecret.length).toBeLessThanOrEqual(11); // 8 chars + "..."
      });

      it("should support pagination", async () => {
        await Promise.all([
          createTestWebhookEndpoint(testToken),
          createTestWebhookEndpoint(testToken),
          createTestWebhookEndpoint(testToken),
        ]);

        const response = await axios.get<
          PaginatedResponse<WebhookEndpointResponse>
        >(`${BASE_URL}/webhooks?limit=2`, {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.data.length).toBeLessThanOrEqual(2);
      });

      it("should round-trip nextCursor for a second page", async () => {
        await Promise.all([
          createTestWebhookEndpoint(testToken),
          createTestWebhookEndpoint(testToken),
          createTestWebhookEndpoint(testToken),
          createTestWebhookEndpoint(testToken),
        ]);

        const page1 = await axios.get<
          PaginatedResponse<WebhookEndpointResponse>
        >(`${BASE_URL}/webhooks?limit=2`, {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });

        expect(page1.status).toBe(HTTP_STATUS.OK);
        expect(page1.data.data.length).toBe(2);
        expect(page1.data.hasMore).toBe(true);
        expect(page1.data.nextCursor).toBeDefined();
        expect(page1.data.nextCursor).not.toBeNull();

        const page2 = await axios.get<
          PaginatedResponse<WebhookEndpointResponse>
        >(
          `${BASE_URL}/webhooks?limit=2&cursor=${encodeURIComponent(
            page1.data.nextCursor!
          )}`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(page2.status).toBe(HTTP_STATUS.OK);
        const page1Ids = new Set(page1.data.data.map((e) => e.id));
        for (const ep of page2.data.data) {
          expect(page1Ids.has(ep.id)).toBe(false);
        }
      });

      it("should filter by status", async () => {
        await createTestWebhookEndpoint(testToken);

        const response = await axios.get<
          PaginatedResponse<WebhookEndpointResponse>
        >(`${BASE_URL}/webhooks?filter[status]=ACTIVE`, {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });

        expect(response.status).toBe(HTTP_STATUS.OK);
        for (const ep of response.data.data) {
          expect(ep.status).toBe("ACTIVE");
        }
      });

      it("should filter by url contains", async () => {
        const uniqueId = generateUniqueId();
        await createTestWebhookEndpoint(testToken, {
          url: `https://unique-${uniqueId}.example.com/webhook`,
        });

        const response = await axios.get<
          PaginatedResponse<WebhookEndpointResponse>
        >(
          `${BASE_URL}/webhooks?filter[url]=unique-${uniqueId}&filter[url_op]=contains`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.data.length).toBeGreaterThanOrEqual(1);
        expect(response.data.data[0].url).toContain(`unique-${uniqueId}`);
      });
    });

    describe("Custom Headers", () => {
      it("should create an endpoint with custom headers", async () => {
        const et = await createTestEventType(testToken);
        const uniqueId = generateUniqueId();

        const response = await axios.post<WebhookEndpointResponse>(
          `${BASE_URL}/webhooks`,
          {
            url: `https://example.com/webhook/${uniqueId}`,
            eventTypes: [et.eventType],
            customHeaders: {
              "X-Custom-Auth": "my-secret-value",
              "X-Tenant-Id": "tenant-123",
            },
          },
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.CREATED);
        expect(response.data.customHeaders).toEqual({
          "X-Custom-Auth": MASK,
          "X-Tenant-Id": MASK,
        });
        const stored = await prisma.webhookEndpoint.findUniqueOrThrow({
          where: { id: response.data.id },
        });
        expect(stored.customHeaders).toEqual({
          "X-Custom-Auth": "my-secret-value",
          "X-Tenant-Id": "tenant-123",
        });
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

    describe("GET /webhooks — description, eventType and archived", () => {
      const tag = generateUniqueId();
      let subscribed: WebhookEndpointResponse;
      let other: WebhookEndpointResponse;
      let archived: WebhookEndpointResponse;
      let eventType: string;

      beforeAll(async () => {
        eventType = (
          await createTestEventType(token, {
            eventType: `test.filters.${tag}.created`,
          })
        ).eventType;
        subscribed = await createTestWebhookEndpoint(token, {
          description: `Billing sync ${tag}`,
          eventTypes: [eventType],
        });
        other = await createTestWebhookEndpoint(token, {
          description: `Inventory ${tag}`,
        });
        archived = await createTestWebhookEndpoint(token, {
          description: `Archived ${tag}`,
          eventTypes: [eventType],
        });
        const res = await axios.post(
          `${BASE_URL}/webhooks/${archived.id}/archive`,
          {},
          { headers: { Authorization: `Bearer ${token}` } }
        );
        expect(res.status).toBe(HTTP_STATUS.OK);
      });

      it("searches description case-insensitively", async () => {
        const res = await listEndpoints(
          `filter[description]=billing SYNC ${tag}&filter[description_op]=contains`,
          token
        );
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(ids(res)).toEqual([subscribed.id]);
      });

      it("filters by an exact subscribed event type", async () => {
        const res = await listEndpoints(
          `filter[eventType]=${eventType}`,
          token
        );
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(ids(res)).toEqual([subscribed.id]);
      });

      it("searches subscribed event types", async () => {
        const res = await listEndpoints(
          `filter[eventType]=FILTERS.${tag}&filter[eventType_op]=contains&includeArchived=true`,
          token
        );
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(ids(res).sort()).toEqual([subscribed.id, archived.id].sort());
        expect(ids(res)).not.toContain(other.id);
      });

      it("filter[archived]=true lists only archived endpoints", async () => {
        const res = await listEndpoints(
          `filter[archived]=true&filter[description]=${tag}&filter[description_op]=contains`,
          token
        );
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(ids(res)).toEqual([archived.id]);
      });

      it("filter[archived]=false lists only unarchived endpoints, even with includeArchived", async () => {
        const res = await listEndpoints(
          `filter[archived]=false&includeArchived=true&filter[description]=${tag}&filter[description_op]=contains`,
          token
        );
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(ids(res).sort()).toEqual([subscribed.id, other.id].sort());
      });

      it("still honours includeArchived", async () => {
        const without = await listEndpoints(
          `filter[description]=${tag}&filter[description_op]=contains`,
          token
        );
        expect(ids(without)).not.toContain(archived.id);

        const withArchived = await listEndpoints(
          `includeArchived=true&filter[description]=${tag}&filter[description_op]=contains`,
          token
        );
        expect(ids(withArchived)).toHaveLength(3);
      });
    });
  });
});
