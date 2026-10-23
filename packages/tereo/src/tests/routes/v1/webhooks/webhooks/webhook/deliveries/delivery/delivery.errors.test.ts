// @module-tag int
// @module-tag webhooks
import { retryDelivery } from "../../../../../../../../routes/v1/webhooks/webhooks/webhook/deliveries/delivery/controllers.js";
import { getWebhookDeliveryQueue } from "../../../../../../../../jobs/webhookQueues.js";
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import type { Response } from "express";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  createTestWebhookEndpoint,
  cleanupTestEntities,
  request,
  response,
  postAs,
  withFailedDeliveries,
  seedDeliveries,
} from "../../../../../../../support/webhooks.js";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";

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

    describe("POST /webhooks/:id/deliveries/:deliveryId/retry", () => {
      it("should return 400 when retrying a PENDING delivery", async () => {
        // Find a PENDING delivery from the setup
        const deliveries = await prisma.webhookDelivery.findMany({
          where: { webhookEndpointId: endpointId, status: "PENDING" },
          take: 1,
        });
        const deliveryId = deliveries[0].id;

        const response = await axios.post(
          `${BASE_URL}/webhooks/${endpointId}/deliveries/${deliveryId}/retry`,
          {},
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
    });

    describe("retry guards and audit", () => {
      it("returns 400 invalid_endpoint_status for a paused or disabled endpoint", async () => {
        const { ep, ids } = await withFailedDeliveries(testToken, 1);
        for (const status of ["PAUSED", "DISABLED"] as const) {
          await prisma.webhookEndpoint.update({
            where: { id: ep.id },
            data: { status },
          });
          for (const path of [
            `/webhooks/${ep.id}/deliveries/${ids[0]}/retry`,
            `/webhooks/${ep.id}/deliveries/retry`,
          ]) {
            const response = await postAs(testToken, path);
            expect(response.status, `${status} ${path}`).toBe(400);
            expect(response.data.error).toBe("invalid_endpoint_status");
          }
        }
        const row = await prisma.webhookDelivery.findFirstOrThrow({
          where: { id: ids[0] },
        });
        expect(row.status).toBe("FAILED");
      });
    });
  });

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

    it("retry one returns 202 with the delivery reset to PENDING", async () => {
      const ep = await createTestWebhookEndpoint(token);
      const delivery = await failedDelivery(ep.id, ep.eventTypes[0]);
      failEnqueue();
      const res = response();

      await retryDelivery(
        request({ id: ep.id, deliveryId: delivery.id }),
        res as unknown as Response
      );

      expect(res.statusCode).toBe(202);
      const row = await prisma.webhookDelivery.findFirstOrThrow({
        where: { id: delivery.id },
      });
      expect(row.status).toBe("PENDING");
      expect(row.attempts).toBe(0);
      // Counts as never attempted, so the sweep's short threshold applies.
      expect(row.lastAttemptAt).toBeNull();
    });
  });
});
