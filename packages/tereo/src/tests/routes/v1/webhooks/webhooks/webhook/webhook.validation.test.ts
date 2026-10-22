// @module-tag int
// @module-tag webhooks
import { HEADER_VALUE_MASK } from "../../../../../../utils/webhookHeaders.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  createTestWebhookEndpoint,
  cleanupTestEntities,
} from "../../../../../support/webhooks.js";

const MASK = HEADER_VALUE_MASK;

describe("/v1/webhooks/webhooks/:id", () => {
  describe("Webhook Endpoint Management", () => {
    let testToken: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("GET /webhooks/:id", () => {
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
    });

    describe("Event Type Validation", () => {
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

    describe("Custom Headers", () => {
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
    });
  });
});
