// @module-tag int
// @module-tag webhooks
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  createTestEventType,
  createTestWebhookEndpoint,
  cleanupTestEntities,
  emitTestEvent,
} from "../../../../../../support/webhooks.js";

describe("GET /v1/webhooks/webhooks/:id/deliveries and POST /v1/webhooks/webhooks/:id/deliveries/retry", () => {
  describe("Webhook Deliveries", () => {
    let testToken: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("POST /webhooks/:id/deliveries/retry (Bulk Retry)", () => {
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
    });
  });
});
