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
        expect(res.data).toMatchObject({
          error: "invalid_request",
          error_description: expect.any(String),
        });
      });
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
      expect(create.data.error).toBe("invalid_request");
      expect(create.data.error_description).toEqual(expect.any(String));
    });
  });
});
