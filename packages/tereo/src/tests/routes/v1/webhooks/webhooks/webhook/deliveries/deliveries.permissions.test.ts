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
} from "../../../../../../support/webhooks.js";

describe("GET /v1/webhooks/webhooks/:id/deliveries and POST /v1/webhooks/webhooks/:id/deliveries/retry", () => {
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

    describe("POST /webhooks/:id/deliveries/retry (Bulk Retry)", () => {
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
    });
  });
});
