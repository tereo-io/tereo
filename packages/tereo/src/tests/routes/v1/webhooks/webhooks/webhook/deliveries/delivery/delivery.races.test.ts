// @module-tag int
// @module-tag webhooks
// @module-tag race
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  createTestWebhookEndpoint,
  cleanupTestEntities,
} from "../../../../../../../support/webhooks.js";

describe("POST /v1/webhooks/webhooks/:id/deliveries/:deliveryId/retry", () => {
  describe("Webhook Deliveries", () => {
    let testToken: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("retry guards and audit", () => {
      const post = (path: string, data: unknown = {}) =>
        axios.post(`${BASE_URL}${path}`, data, {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });

      /** An endpoint with `count` FAILED deliveries. */
      const withFailedDeliveries = async (count: number) => {
        const ep = await createTestWebhookEndpoint(testToken);
        const ids: string[] = [];
        for (let i = 0; i < count; i++) {
          const delivery = await prisma.webhookDelivery.create({
            data: {
              webhookEndpointId: ep.id,
              eventType: ep.eventTypes[0],
              payload: { n: i },
              status: "FAILED",
              attempts: 10,
              completedAt: new Date(),
            },
          });
          ids.push(delivery.id);
        }
        return { ep, ids };
      };

      it("resets a delivery once when two retries race", async () => {
        const { ep, ids } = await withFailedDeliveries(1);
        const path = `/webhooks/${ep.id}/deliveries/${ids[0]}/retry`;

        const responses = await Promise.all([post(path), post(path)]);

        const statuses = responses.map((r) => r.status).sort();
        expect(statuses).toEqual([
          HTTP_STATUS.ACCEPTED,
          HTTP_STATUS.BAD_REQUEST,
        ]);
        const rejected = responses.find((r) => r.status === 400)!;
        expect(rejected.data.error).toBe("invalid_delivery_status");
      });
    });
  });
});
