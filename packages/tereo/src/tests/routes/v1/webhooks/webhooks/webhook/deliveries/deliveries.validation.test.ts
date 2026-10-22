// @module-tag int
// @module-tag webhooks
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
  WebhookDeliveryResponse,
  PaginatedResponse,
  type WebhookEndpointResponse,
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

    beforeAll(async () => {
      testToken = await getTestAccessToken();

      const et = await createTestEventType(testToken);
      const ep = await createTestWebhookEndpoint(testToken, {
        eventTypes: [et.eventType],
      });
      endpointId = ep.id;
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("GET /webhooks/:id/deliveries", () => {
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

      it("returns 400 for an invalid date or an equality filter", async () => {
        const invalid = await deliveries("filter[createdAt_gte]=not-a-date");
        expect(invalid.status).toBe(HTTP_STATUS.BAD_REQUEST);

        const equals = await deliveries(
          `filter[createdAt]=${before.toISOString()}`
        );
        expect(equals.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });
    });
  });

  // Input that reached Postgres and failed there with a 500.
  describe("Webhook input Postgres cannot take", () => {
    let token: string;
    let endpoint: WebhookEndpointResponse;
    const cfg = () => ({
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });

    beforeAll(async () => {
      token = await getTestAccessToken();
      endpoint = await createTestWebhookEndpoint(token);
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    it.each([
      ["a NUL in filter[eventType]", "filter[eventType]=%00"],
      [
        "a createdAt bound outside the years 1-9999",
        "filter[createdAt_gte]=-271821-04-20T00:00:00Z",
      ],
    ])("refuses %s on the delivery list with a 400", async (_label, query) => {
      const res = await axios.get(
        `${BASE_URL}/webhooks/${endpoint.id}/deliveries?${query}`,
        cfg()
      );
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it.each([
      ["a NUL in eventType", { eventType: "a\u0000" }],
      ["a date outside the years 1-9999", { createdAfter: "-271821-04-20" }],
    ])("refuses %s in a bulk retry with a 400", async (_label, body) => {
      const res = await axios.post(
        `${BASE_URL}/webhooks/${endpoint.id}/deliveries/retry`,
        body,
        cfg()
      );
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });
});
