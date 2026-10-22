// @module-tag int
// @module-tag webhooks
// @module-tag race
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import axios from "axios";
import {
  BASE_URL,
  getTestAccessToken,
  createTestWebhookEndpoint,
  cleanupTestEntities,
} from "../../../../../../support/webhooks.js";

describe("POST /v1/webhooks/webhooks/:id/deliveries/retry", () => {
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

      it("never resets the same delivery in two concurrent bulk retries", async () => {
        const { ep } = await withFailedDeliveries(5);
        const path = `/webhooks/${ep.id}/deliveries/retry`;

        const responses = await Promise.all([post(path), post(path)]);

        expect(responses.map((r) => r.status)).toEqual([202, 202]);
        const total = responses.reduce((n, r) => n + r.data.retriedCount, 0);
        expect(total).toBe(5);
      });
    });
  });
});
