// @module-tag int
// @module-tag webhooks
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../utils/db/prisma.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  createTestEventType,
  createTestWebhookEndpoint,
  cleanupTestEntities,
  generateUniqueId,
  type WebhookEndpointResponse,
  PaginatedResponse,
} from "../../../../support/webhooks.js";

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
    });

    describe("GET /webhooks", () => {
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
    });

    describe("Custom Headers", () => {
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

  describe("Webhook list filters and fields", () => {
    let token: string;

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    describe("GET /webhooks — description, eventType and archived", () => {
      it("returns 400 for a non-boolean archived filter", async () => {
        const res = await listEndpoints("filter[archived]=maybe", token);
        expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
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
      ["a NUL in filter[url]", "/webhooks?filter[url]=a%00"],
      ["a NUL in filter[description]", "/webhooks?filter[description]=%00"],
      ["a NUL in filter[eventType]", "/webhooks?filter[eventType]=%00"],
      ["a NUL in an event-type filter", "/event-types?filter[eventType]=%00"],
      ["a NUL in an event-type source", "/event-types?filter[source]=%00"],
      ["a NUL in an event-type path", "/event-types/a%00"],
      [
        "an event-type path over 100 characters",
        `/event-types/${"a".repeat(101)}`,
      ],
      [
        "a filter value over 500 characters",
        `/webhooks?filter[url]=${"u".repeat(501)}`,
      ],
    ])("refuses %s with a 400", async (_label, path) => {
      const res = await axios.get(`${BASE_URL}${path}`, cfg());
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it.each([
      ["a NUL in the description", { description: "a\u0000" }],
      ["a NUL in an event type", { eventTypes: ["a\u0000"] }],
      [
        "a NUL in a custom header value",
        { customHeaders: { "X-A": "\u0000" } },
      ],
      [
        "a CRLF in a custom header value",
        { customHeaders: { "X-A": "a\r\nb" } },
      ],
      [
        "a character fetch cannot send in a custom header value",
        { customHeaders: { "X-A": "\u2603" } },
      ],
      [
        "more than 100 event types",
        { eventTypes: Array.from({ length: 101 }, (_, i) => `x.type-${i}`) },
      ],
    ])("refuses %s on create and update with a 400", async (_label, fields) => {
      const created = await axios.post(
        `${BASE_URL}/webhooks`,
        {
          url: "https://example.com/hook",
          eventTypes: endpoint.eventTypes,
          ...fields,
        },
        cfg()
      );
      expect(created.status).toBe(HTTP_STATUS.BAD_REQUEST);

      const updated = await axios.patch(
        `${BASE_URL}/webhooks/${endpoint.id}`,
        fields,
        cfg()
      );
      expect(updated.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });

  describe("Expect as a custom webhook header", () => {
    let token: string;

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    it("is something fetch refuses to send, failing every delivery", async () => {
      await expect(
        fetch("http://127.0.0.1:1/", {
          method: "POST",
          body: "{}",
          headers: { Expect: "100-continue" },
        })
      ).rejects.toThrow();
    });

    it("returns 400 on create and update", async () => {
      const et = await createTestEventType(token);
      const auth = {
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      };
      const endpoint = await createTestWebhookEndpoint(token, {
        eventTypes: [et.eventType],
      });

      const create = await axios.post(
        `${BASE_URL}/webhooks`,
        {
          url: `https://example.com/webhook/${generateUniqueId()}`,
          eventTypes: [et.eventType],
          customHeaders: { Expect: "100-continue" },
        },
        auth
      );
      expect(create.status).toBe(HTTP_STATUS.BAD_REQUEST);

      const update = await axios.patch(
        `${BASE_URL}/webhooks/${endpoint.id}`,
        { customHeaders: { expect: "100-continue" } },
        auth
      );
      expect(update.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });
});
