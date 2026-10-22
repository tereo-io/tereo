// @module-tag int
// @module-tag webhooks
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import axios from "axios";
import {
  BASE_URL,
  getTestAccessToken,
  createTestWebhookEndpoint,
  cleanupTestEntities,
} from "../../../../../../../support/webhooks.js";

describe("GET /v1/webhooks/webhooks/:id/deliveries/:deliveryId and POST /v1/webhooks/webhooks/:id/deliveries/:deliveryId/retry", () => {
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

      it("writes an audit entry for a retry and a bulk retry", async () => {
        const { ep, ids } = await withFailedDeliveries(3);

        expect(
          (await post(`/webhooks/${ep.id}/deliveries/${ids[0]}/retry`)).status
        ).toBe(202);
        const bulk = await post(`/webhooks/${ep.id}/deliveries/retry`);
        expect(bulk.data.retriedCount).toBe(2);

        const single = await prisma.auditLogEntry.findFirst({
          where: { entityType: "WebhookDelivery", entityId: ids[0] },
        });
        expect(single?.action).toBe("UPDATE");
        expect(single?.metadata).toMatchObject({
          action: "retry",
          webhookEndpointId: ep.id,
        });
        const many = await prisma.auditLogEntry.findFirst({
          where: {
            entityType: "WebhookEndpoint",
            entityId: ep.id,
            action: "UPDATE",
          },
        });
        expect(many?.metadata).toMatchObject({
          action: "retry-deliveries",
          retriedCount: 2,
        });
      });
    });
  });
});
