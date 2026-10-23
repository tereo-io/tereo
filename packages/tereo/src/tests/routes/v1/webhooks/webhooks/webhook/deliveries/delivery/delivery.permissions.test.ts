// @module-tag int
// @module-tag webhooks
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  cleanupTestEntities,
  seedDeliveries,
} from "../../../../../../../support/webhooks.js";

describe("GET /v1/webhooks/webhooks/:id/deliveries/:deliveryId and POST /v1/webhooks/webhooks/:id/deliveries/:deliveryId/retry", () => {
  describe("Webhook Deliveries", () => {
    let testToken: string;
    let endpointId: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();

      // Set up: an event type and endpoint with delivery records
      ({ endpointId } = await seedDeliveries(testToken, 1));
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
