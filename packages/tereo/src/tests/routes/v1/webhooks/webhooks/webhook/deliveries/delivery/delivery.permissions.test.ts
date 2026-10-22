// @module-tag int
// @module-tag webhooks
import { prisma } from "../../../../../../../../utils/db/prisma.js";
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
} from "../../../../../../../support/webhooks.js";

describe("GET /v1/webhooks/webhooks/:id/deliveries/:deliveryId and POST /v1/webhooks/webhooks/:id/deliveries/:deliveryId/retry", () => {
  describe("Webhook Deliveries", () => {
    let testToken: string;
    let endpointId: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();

      // Set up: create an event type and endpoint, then emit an event to generate deliveries
      const et = await createTestEventType(testToken);

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

    describe("GET /webhooks/:id/deliveries/:deliveryId", () => {
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
  });
});
