import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { HEADER_VALUE_MASK } from "../../utils/webhookHeaders.js";
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
  emitTestEvent,
  generateUniqueId,
  WebhookEndpointResponse,
  PaginatedResponse,
} from "./utils/test-helpers.js";

const MASK = HEADER_VALUE_MASK;

describe("Webhook Endpoint Management", () => {
  let testToken: string;

  beforeAll(async () => {
    testToken = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("POST /webhooks", () => {
    it("should return 400 masked_header_value when a header value is the mask", async () => {
      const et = await createTestEventType(testToken);
      const url = `https://example.com/webhook/${generateUniqueId()}`;

      const response = await axios.post(
        `${BASE_URL}/webhooks`,
        {
          url,
          eventTypes: [et.eventType],
          customHeaders: { "X-Api-Key": "********" },
        },
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(response.data.error).toBe("masked_header_value");
      expect(await prisma.webhookEndpoint.count({ where: { url } })).toBe(0);
    });

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
      expect(response.data.url).toBe(`https://example.com/webhook/${uniqueId}`);
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

    it("should return 400 for missing url", async () => {
      const et = await createTestEventType(testToken);

      const response = await axios.post(
        `${BASE_URL}/webhooks`,
        {
          description: "Missing url",
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

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should return 400 for invalid url", async () => {
      const response = await axios.post(
        `${BASE_URL}/webhooks`,
        {
          url: "not-a-valid-url",
          eventTypes: ["test.event"],
        },
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

    it("should return 400 for missing eventTypes", async () => {
      const response = await axios.post(
        `${BASE_URL}/webhooks`,
        {
          url: "https://example.com/webhook",
        },
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

    it("should return 400 for empty eventTypes array", async () => {
      const response = await axios.post(
        `${BASE_URL}/webhooks`,
        {
          url: "https://example.com/webhook",
          eventTypes: [],
        },
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

    it("should return 401 without authentication", async () => {
      const response = await axios.post(
        `${BASE_URL}/webhooks`,
        {
          url: "https://example.com/webhook",
          eventTypes: ["test.event"],
        },
        {
          headers: { "Content-Type": "application/json" },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it("should return 403 without org_id in token", async () => {
      // Token with no organization
      const tokenNoOrg = await getTestAccessToken(undefined, null);

      const response = await axios.post(
        `${BASE_URL}/webhooks`,
        {
          url: "https://example.com/webhook",
          eventTypes: ["test.event"],
        },
        {
          headers: {
            Authorization: `Bearer ${tokenNoOrg}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
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

      const page1 = await axios.get<PaginatedResponse<WebhookEndpointResponse>>(
        `${BASE_URL}/webhooks?limit=2`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(page1.status).toBe(HTTP_STATUS.OK);
      expect(page1.data.data.length).toBe(2);
      expect(page1.data.hasMore).toBe(true);
      expect(page1.data.nextCursor).toBeDefined();
      expect(page1.data.nextCursor).not.toBeNull();

      const page2 = await axios.get<PaginatedResponse<WebhookEndpointResponse>>(
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

    it("should return 400 for an invalid/tampered cursor", async () => {
      const response = await axios.get(
        `${BASE_URL}/webhooks?cursor=not-a-real-cursor`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(response.data.error).toBe("invalid_cursor");
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

    it("returns 400 for a non-uuid id", async () => {
      for (const [method, path] of [
        ["get", ""],
        ["get", "/stats"],
        ["patch", ""],
        ["delete", ""],
        ["post", "/archive"],
        ["post", "/restore"],
        ["post", "/test"],
        ["post", "/rotate-secret"],
      ] as const) {
        const response = await axios.request({
          method,
          url: `${BASE_URL}/webhooks/not-a-uuid${path}`,
          data: method === "get" ? undefined : {},
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });
        expect(response.status, `${method} ${path}`).toBe(
          HTTP_STATUS.BAD_REQUEST
        );
        expect(response.data.error).toBe("invalid_request");
      }
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

    it("should return 404 for endpoint belonging to different client", async () => {
      const ep = await createTestWebhookEndpoint(testToken);

      // Use a token with a different org
      const otherToken = await getTestAccessToken(
        "00000000-0000-7001-0000-000000000002",
        "other-org-1"
      );

      const response = await axios.get(`${BASE_URL}/webhooks/${ep.id}`, {
        headers: { Authorization: `Bearer ${otherToken}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });
  });

  describe("PATCH /webhooks/:id", () => {
    it("should update webhook url", async () => {
      const ep = await createTestWebhookEndpoint(testToken);
      const newUrl = `https://updated-${generateUniqueId()}.example.com/webhook`;

      const response = await axios.patch<WebhookEndpointResponse>(
        `${BASE_URL}/webhooks/${ep.id}`,
        { url: newUrl },
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.url).toBe(newUrl);
    });

    it("should update webhook description", async () => {
      const ep = await createTestWebhookEndpoint(testToken);

      const response = await axios.patch<WebhookEndpointResponse>(
        `${BASE_URL}/webhooks/${ep.id}`,
        { description: "Updated description" },
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.description).toBe("Updated description");
    });

    it("should update webhook eventTypes", async () => {
      const ep = await createTestWebhookEndpoint(testToken);
      const newEt = await createTestEventType(testToken);

      const response = await axios.patch<WebhookEndpointResponse>(
        `${BASE_URL}/webhooks/${ep.id}`,
        { eventTypes: [newEt.eventType] },
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.eventTypes).toContain(newEt.eventType);
    });

    it("should update webhook status", async () => {
      const ep = await createTestWebhookEndpoint(testToken);

      const response = await axios.patch<WebhookEndpointResponse>(
        `${BASE_URL}/webhooks/${ep.id}`,
        { status: "PAUSED" },
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.status).toBe("PAUSED");
    });

    it("should return masked secret in update response", async () => {
      const ep = await createTestWebhookEndpoint(testToken);

      const response = await axios.patch<WebhookEndpointResponse>(
        `${BASE_URL}/webhooks/${ep.id}`,
        { description: "Check secret masking" },
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.signingSecret).toContain("...");
    });

    it("should return 404 for endpoint belonging to different client", async () => {
      const ep = await createTestWebhookEndpoint(testToken);
      const otherToken = await getTestAccessToken(
        "00000000-0000-7001-0000-000000000002",
        "other-org-1"
      );

      const response = await axios.patch(
        `${BASE_URL}/webhooks/${ep.id}`,
        { description: "Should fail" },
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

  describe("DELETE /webhooks/:id", () => {
    it("should hard delete a webhook endpoint with no deliveries (204, then 404)", async () => {
      const ep = await createTestWebhookEndpoint(testToken);

      const response = await axios.delete(`${BASE_URL}/webhooks/${ep.id}`, {
        headers: { Authorization: `Bearer ${testToken}` },
        validateStatus: () => true,
      });
      expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);

      const getResponse = await axios.get(`${BASE_URL}/webhooks/${ep.id}`, {
        headers: { Authorization: `Bearer ${testToken}` },
        validateStatus: () => true,
      });
      expect(getResponse.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("should 409 when the endpoint still has delivery history", async () => {
      const ep = await createTestWebhookEndpoint(testToken);
      // POST /test creates a WebhookDelivery row referencing the endpoint.
      const testResponse = await axios.post(
        `${BASE_URL}/webhooks/${ep.id}/test`,
        {},
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(testResponse.status).toBe(HTTP_STATUS.ACCEPTED);

      const response = await axios.delete(`${BASE_URL}/webhooks/${ep.id}`, {
        headers: { Authorization: `Bearer ${testToken}` },
        validateStatus: () => true,
      });
      expect(response.status).toBe(409);
    });

    it("should return 404 for endpoint belonging to different client", async () => {
      const ep = await createTestWebhookEndpoint(testToken);
      const otherToken = await getTestAccessToken(
        "00000000-0000-7001-0000-000000000002",
        "other-org-1"
      );

      const response = await axios.delete(`${BASE_URL}/webhooks/${ep.id}`, {
        headers: { Authorization: `Bearer ${otherToken}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });
  });

  describe("POST /webhooks/:id/archive + /restore", () => {
    it("archives an endpoint, hides it from the default list, then restores it", async () => {
      const ep = await createTestWebhookEndpoint(testToken);

      const archiveResponse = await axios.post<WebhookEndpointResponse>(
        `${BASE_URL}/webhooks/${ep.id}/archive`,
        {},
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(archiveResponse.status).toBe(HTTP_STATUS.OK);
      expect(archiveResponse.data.archivedAt).not.toBeNull();

      // By-id GET still returns the archived endpoint.
      const getResponse = await axios.get<WebhookEndpointResponse>(
        `${BASE_URL}/webhooks/${ep.id}`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(getResponse.status).toBe(HTTP_STATUS.OK);
      expect(getResponse.data.archivedAt).not.toBeNull();

      // Default list excludes it; includeArchived surfaces it.
      const defaultList = await axios.get<{ data: WebhookEndpointResponse[] }>(
        `${BASE_URL}/webhooks?limit=100`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(defaultList.data.data.some((e) => e.id === ep.id)).toBe(false);

      const archivedList = await axios.get<{ data: WebhookEndpointResponse[] }>(
        `${BASE_URL}/webhooks?limit=100&includeArchived=true`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(archivedList.data.data.some((e) => e.id === ep.id)).toBe(true);

      const restoreResponse = await axios.post<WebhookEndpointResponse>(
        `${BASE_URL}/webhooks/${ep.id}/restore`,
        {},
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(restoreResponse.status).toBe(HTTP_STATUS.OK);
      expect(restoreResponse.data.archivedAt).toBeNull();
    });

    it("409s on archiving an already-archived endpoint", async () => {
      const ep = await createTestWebhookEndpoint(testToken);
      await axios.post(
        `${BASE_URL}/webhooks/${ep.id}/archive`,
        {},
        { headers: { Authorization: `Bearer ${testToken}` } }
      );
      const response = await axios.post(
        `${BASE_URL}/webhooks/${ep.id}/archive`,
        {},
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(response.status).toBe(409);
      expect(response.data.error).toBe("already_archived");
    });

    it("409s on restoring an endpoint that is not archived", async () => {
      const ep = await createTestWebhookEndpoint(testToken);
      const response = await axios.post(
        `${BASE_URL}/webhooks/${ep.id}/restore`,
        {},
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(response.status).toBe(HTTP_STATUS.CONFLICT);
      expect(response.data.error).toBe("not_archived");
    });

    it("409s on PATCHing an archived endpoint (read-only)", async () => {
      const ep = await createTestWebhookEndpoint(testToken);
      await axios.post(
        `${BASE_URL}/webhooks/${ep.id}/archive`,
        {},
        { headers: { Authorization: `Bearer ${testToken}` } }
      );
      const response = await axios.patch(
        `${BASE_URL}/webhooks/${ep.id}`,
        { description: "nope" },
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(response.status).toBe(409);
    });

    it("409s on rotate-secret and test for an archived endpoint", async () => {
      const ep = await createTestWebhookEndpoint(testToken);
      await axios.post(
        `${BASE_URL}/webhooks/${ep.id}/archive`,
        {},
        { headers: { Authorization: `Bearer ${testToken}` } }
      );
      const rotate = await axios.post(
        `${BASE_URL}/webhooks/${ep.id}/rotate-secret`,
        {},
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(rotate.status).toBe(409);

      const test = await axios.post(
        `${BASE_URL}/webhooks/${ep.id}/test`,
        {},
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(test.status).toBe(409);
    });

    it("excludes an archived-but-ACTIVE endpoint from event fan-out", async () => {
      const et = await createTestEventType(testToken);
      const ep = await createTestWebhookEndpoint(testToken, {
        eventTypes: [et.eventType],
      });
      expect(ep.status).toBe("ACTIVE");

      // Baseline: the ACTIVE endpoint receives the event.
      const before = await emitTestEvent(testToken, {
        eventType: et.eventType,
      });
      expect(before.deliveriesCreated).toBe(1);

      // Archive (status stays ACTIVE) — fan-out must now skip it.
      await axios.post(
        `${BASE_URL}/webhooks/${ep.id}/archive`,
        {},
        { headers: { Authorization: `Bearer ${testToken}` } }
      );
      const after = await emitTestEvent(testToken, {
        eventType: et.eventType,
      });
      expect(after.deliveriesCreated).toBe(0);
    });
  });

  describe("POST /webhooks/:id/rotate-secret", () => {
    it("should rotate the signing secret", async () => {
      const ep = await createTestWebhookEndpoint(testToken);
      const originalSecret = ep.signingSecret;

      const response = await axios.post<WebhookEndpointResponse>(
        `${BASE_URL}/webhooks/${ep.id}/rotate-secret`,
        {},
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.OK);
      // Full new secret should be returned
      expect(response.data.signingSecret).toBeDefined();
      expect(response.data.signingSecret.length).toBeGreaterThan(8);
      expect(response.data.signingSecret).not.toContain("...");
      // New secret should be different from original
      expect(response.data.signingSecret).not.toBe(originalSecret);
    });

    it("should return 404 for endpoint belonging to different client", async () => {
      const ep = await createTestWebhookEndpoint(testToken);
      const otherToken = await getTestAccessToken(
        "00000000-0000-7001-0000-000000000002",
        "other-org-1"
      );

      const response = await axios.post(
        `${BASE_URL}/webhooks/${ep.id}/rotate-secret`,
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

  describe("Event Type Validation", () => {
    it("should return 400 on create with unregistered event types", async () => {
      const response = await axios.post(
        `${BASE_URL}/webhooks`,
        {
          url: `https://example.com/webhook/${generateUniqueId()}`,
          eventTypes: ["nonexistent.event.type"],
        },
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

    it("should return 400 on update with unregistered event types", async () => {
      const ep = await createTestWebhookEndpoint(testToken);

      const response = await axios.patch(
        `${BASE_URL}/webhooks/${ep.id}`,
        { eventTypes: ["nonexistent.event.type"] },
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

    it("returns 400 reserved_event_type on create subscribing to webhook.test", async () => {
      const et = await createTestEventType(testToken);
      const response = await axios.post(
        `${BASE_URL}/webhooks`,
        {
          url: `https://example.com/webhook/${generateUniqueId()}`,
          eventTypes: [et.eventType, "webhook.test"],
        },
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(response.data.error).toBe("reserved_event_type");
    });

    it("returns 400 reserved_event_type on update subscribing to webhook.test", async () => {
      const ep = await createTestWebhookEndpoint(testToken);

      const response = await axios.patch(
        `${BASE_URL}/webhooks/${ep.id}`,
        { eventTypes: ["webhook.test"] },
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(response.data.error).toBe("reserved_event_type");
      const subscriptions = await prisma.webhookEndpointEventType.findMany({
        where: { webhookEndpointId: ep.id },
      });
      expect(subscriptions.map((s) => s.eventType)).not.toContain(
        "webhook.test"
      );
    });
  });

  describe("POST /webhooks/:id/test", () => {
    it("should send a test delivery and return 202 with deliveryId", async () => {
      const ep = await createTestWebhookEndpoint(testToken);

      const response = await axios.post<{ deliveryId: string }>(
        `${BASE_URL}/webhooks/${ep.id}/test`,
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
      expect(response.data.deliveryId).toBeDefined();

      // Verify the delivery was created with webhook.test event type
      const delivery = await prisma.webhookDelivery.findUnique({
        where: { id: response.data.deliveryId },
      });
      expect(delivery).not.toBeNull();
      expect(delivery!.eventType).toBe("webhook.test");
      expect(delivery!.webhookEndpointId).toBe(ep.id);
    });

    it("should return 400 for PAUSED endpoint", async () => {
      const ep = await createTestWebhookEndpoint(testToken);

      // Pause the endpoint first
      await axios.patch(
        `${BASE_URL}/webhooks/${ep.id}`,
        { status: "PAUSED" },
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      const response = await axios.post(
        `${BASE_URL}/webhooks/${ep.id}/test`,
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

    it("should return 404 for cross-tenant test", async () => {
      const ep = await createTestWebhookEndpoint(testToken);
      const otherToken = await getTestAccessToken(
        "00000000-0000-7001-0000-000000000002",
        "other-org-1"
      );

      const response = await axios.post(
        `${BASE_URL}/webhooks/${ep.id}/test`,
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

    it("should update custom headers via PATCH", async () => {
      const ep = await createTestWebhookEndpoint(testToken);

      const response = await axios.patch<WebhookEndpointResponse>(
        `${BASE_URL}/webhooks/${ep.id}`,
        {
          customHeaders: { "X-New-Header": "new-value" },
        },
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.customHeaders).toEqual({ "X-New-Header": MASK });
      const stored = await prisma.webhookEndpoint.findUniqueOrThrow({
        where: { id: ep.id },
      });
      expect(stored.customHeaders).toEqual({ "X-New-Header": "new-value" });
    });

    it("keeps a stored value when PATCH sends back its mask", async () => {
      const ep = await createTestWebhookEndpoint(testToken);
      await prisma.webhookEndpoint.update({
        where: { id: ep.id },
        data: {
          customHeaders: { "X-Api-Key": "secret-key", "X-Tenant": "t-1" },
        },
      });

      // What the admin UI sends after editing one header of the masked set.
      const response = await axios.patch<WebhookEndpointResponse>(
        `${BASE_URL}/webhooks/${ep.id}`,
        {
          customHeaders: {
            "X-Api-Key": MASK,
            "X-Tenant": "t-2",
            "X-Added": "new",
          },
        },
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.customHeaders).toEqual({
        "X-Api-Key": MASK,
        "X-Tenant": MASK,
        "X-Added": MASK,
      });
      const stored = await prisma.webhookEndpoint.findUniqueOrThrow({
        where: { id: ep.id },
      });
      expect(stored.customHeaders).toEqual({
        "X-Api-Key": "secret-key",
        "X-Tenant": "t-2",
        "X-Added": "new",
      });

      const entry = await prisma.auditLogEntry.findFirstOrThrow({
        where: {
          entityType: "WebhookEndpoint",
          entityId: ep.id,
          action: "UPDATE",
        },
        orderBy: { createdAt: "desc" },
      });
      expect(JSON.stringify(entry)).not.toContain("secret-key");
      expect(JSON.stringify(entry)).not.toContain("t-1");
      expect(JSON.stringify(entry)).not.toContain("t-2");
      expect((entry.changes as Record<string, unknown>).customHeaders).toEqual({
        old: { "X-Api-Key": MASK, "X-Tenant": MASK },
        new: { "X-Api-Key": MASK, "X-Tenant": MASK, "X-Added": MASK },
      });
    });

    it("records a value-only header change in the audit entry, masked", async () => {
      const ep = await createTestWebhookEndpoint(testToken);
      await prisma.webhookEndpoint.update({
        where: { id: ep.id },
        data: { customHeaders: { "X-Api-Key": "old-key" } },
      });

      const response = await axios.patch(
        `${BASE_URL}/webhooks/${ep.id}`,
        { customHeaders: { "X-Api-Key": "new-key" } },
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(response.status).toBe(HTTP_STATUS.OK);

      const entry = await prisma.auditLogEntry.findFirstOrThrow({
        where: {
          entityType: "WebhookEndpoint",
          entityId: ep.id,
          action: "UPDATE",
        },
        orderBy: { createdAt: "desc" },
      });
      expect(JSON.stringify(entry)).not.toContain("-key");
      expect((entry.changes as Record<string, unknown>).customHeaders).toEqual({
        old: { "X-Api-Key": MASK },
        new: { "X-Api-Key": MASK },
      });
    });

    it("should return 400 when the mask is sent for a header with no stored value", async () => {
      const ep = await createTestWebhookEndpoint(testToken);
      await prisma.webhookEndpoint.update({
        where: { id: ep.id },
        data: { customHeaders: { "X-Api-Key": "secret-key" } },
      });

      // A renamed header keeps the placeholder but has no value to keep.
      const response = await axios.patch(
        `${BASE_URL}/webhooks/${ep.id}`,
        { customHeaders: { "X-Renamed-Key": MASK } },
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(response.data.error).toBe("masked_header_value");
      const stored = await prisma.webhookEndpoint.findUniqueOrThrow({
        where: { id: ep.id },
      });
      expect(stored.customHeaders).toEqual({ "X-Api-Key": "secret-key" });
    });

    it("keeps a stored value when the mask comes back under another case", async () => {
      const ep = await createTestWebhookEndpoint(testToken);
      await prisma.webhookEndpoint.update({
        where: { id: ep.id },
        data: { customHeaders: { "X-Api-Key": "secret-key" } },
      });

      const response = await axios.patch(
        `${BASE_URL}/webhooks/${ep.id}`,
        { customHeaders: { "x-api-key": MASK } },
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.OK);
      const stored = await prisma.webhookEndpoint.findUniqueOrThrow({
        where: { id: ep.id },
      });
      expect(stored.customHeaders).toEqual({ "x-api-key": "secret-key" });
    });

    it("refuses two header names that differ only in case", async () => {
      const ep = await createTestWebhookEndpoint(testToken);
      const headers = { "X-Api-Key": "one", "x-api-key": "two" };
      const auth = {
        headers: { Authorization: `Bearer ${testToken}` },
        validateStatus: () => true,
      };

      const created = await axios.post(
        `${BASE_URL}/webhooks`,
        {
          url: "https://example.com/hook",
          eventTypes: ep.eventTypes,
          customHeaders: headers,
        },
        auth
      );
      expect(created.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const updated = await axios.patch(
        `${BASE_URL}/webhooks/${ep.id}`,
        { customHeaders: headers },
        auth
      );
      expect(updated.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should clear custom headers by setting to null", async () => {
      const et = await createTestEventType(testToken);
      const uniqueId = generateUniqueId();

      const createResponse = await axios.post<WebhookEndpointResponse>(
        `${BASE_URL}/webhooks`,
        {
          url: `https://example.com/webhook/${uniqueId}`,
          eventTypes: [et.eventType],
          customHeaders: { "X-To-Remove": "value" },
        },
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      const patchResponse = await axios.patch<WebhookEndpointResponse>(
        `${BASE_URL}/webhooks/${createResponse.data.id}`,
        { customHeaders: null },
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      expect(patchResponse.status).toBe(HTTP_STATUS.OK);
      expect(patchResponse.data.customHeaders).toBeNull();
    });

    it("should return 400 for reserved header names", async () => {
      const et = await createTestEventType(testToken);

      const response = await axios.post(
        `${BASE_URL}/webhooks`,
        {
          url: `https://example.com/webhook/${generateUniqueId()}`,
          eventTypes: [et.eventType],
          customHeaders: { "X-Webhook-Signature": "hack" },
        },
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

    it("returns 400 for hop-by-hop and framing headers, on create and update", async () => {
      const et = await createTestEventType(testToken);
      const auth = {
        headers: { Authorization: `Bearer ${testToken}` },
        validateStatus: () => true,
      };
      const created = {
        data: await createTestWebhookEndpoint(testToken, {
          eventTypes: [et.eventType],
        }),
      };

      for (const name of [
        "Connection",
        "transfer-encoding",
        "Keep-Alive",
        "Upgrade",
        "TE",
        "Trailer",
        "Proxy-Authorization",
        "proxy-connection",
        "Content-Length",
        "HOST",
      ]) {
        const create = await axios.post(
          `${BASE_URL}/webhooks`,
          {
            url: `https://example.com/webhook/${generateUniqueId()}`,
            eventTypes: [et.eventType],
            customHeaders: { [name]: "x" },
          },
          auth
        );
        expect(create.status, `create ${name}`).toBe(HTTP_STATUS.BAD_REQUEST);

        const update = await axios.patch(
          `${BASE_URL}/webhooks/${created.data.id}`,
          { customHeaders: { [name]: "x" } },
          auth
        );
        expect(update.status, `update ${name}`).toBe(HTTP_STATUS.BAD_REQUEST);
      }

      // A name that only starts like one is fine.
      const allowed = await axios.patch(
        `${BASE_URL}/webhooks/${created.data.id}`,
        { customHeaders: { "X-Upgrade-Hint": "x", Tenant: "t" } },
        auth
      );
      expect(allowed.status).toBe(HTTP_STATUS.OK);
    });

    it("should return 400 for more than 10 custom headers", async () => {
      const et = await createTestEventType(testToken);
      const headers: Record<string, string> = {};
      for (let i = 0; i < 11; i++) {
        headers[`X-Header-${i}`] = `value-${i}`;
      }

      const response = await axios.post(
        `${BASE_URL}/webhooks`,
        {
          url: `https://example.com/webhook/${generateUniqueId()}`,
          eventTypes: [et.eventType],
          customHeaders: headers,
        },
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

    it("should return 400 for invalid header name characters", async () => {
      const et = await createTestEventType(testToken);

      const response = await axios.post(
        `${BASE_URL}/webhooks`,
        {
          url: `https://example.com/webhook/${generateUniqueId()}`,
          eventTypes: [et.eventType],
          customHeaders: { "Invalid Header Name": "value" },
        },
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
  });
});
