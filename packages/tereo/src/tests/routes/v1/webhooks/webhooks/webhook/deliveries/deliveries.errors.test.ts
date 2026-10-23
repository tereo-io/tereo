// @module-tag int
// @module-tag webhooks
import { bulkRetryDeliveries } from "../../../../../../../routes/v1/webhooks/webhooks/webhook/deliveries/controllers.js";
import { getWebhookDeliveryQueue } from "../../../../../../../jobs/webhookQueues.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import type { Response } from "express";
import {
  getTestAccessToken,
  createTestWebhookEndpoint,
  cleanupTestEntities,
  request,
  response,
} from "../../../../../../support/webhooks.js";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";

describe("POST /v1/webhooks/webhooks/:id/deliveries/retry", () => {
  // Redis refusing the job after the delivery committed: the request must still
  // succeed, or the client retries and the delivery is written twice. The
  // stale-delivery sweep queues it later.
  describe("Enqueue failure after the delivery commits", () => {
    let token: string;

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    const failEnqueue = () =>
      vi
        .spyOn(getWebhookDeliveryQueue(), "add")
        .mockRejectedValue(new Error("redis went away"));

    const failedDelivery = async (
      webhookEndpointId: string,
      eventType: string
    ) =>
      prisma.webhookDelivery.create({
        data: {
          webhookEndpointId,
          eventType,
          payload: { n: 1 },
          status: "FAILED",
          attempts: 10,
          lastAttemptAt: new Date(),
          completedAt: new Date(),
        },
      });

    it("bulk retry returns 202 with every delivery reset", async () => {
      const ep = await createTestWebhookEndpoint(token);
      await failedDelivery(ep.id, ep.eventTypes[0]);
      await failedDelivery(ep.id, ep.eventTypes[0]);
      failEnqueue();
      const res = response();

      await bulkRetryDeliveries(
        request({ id: ep.id }, { limit: 100 }),
        res as unknown as Response
      );

      expect(res.statusCode).toBe(202);
      expect(res.body).toEqual({ retriedCount: 2 });
      const pending = await prisma.webhookDelivery.count({
        where: { webhookEndpointId: ep.id, status: "PENDING" },
      });
      expect(pending).toBe(2);
    });
  });
});
