// @module-tag int
// @module-tag webhooks
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getTestAccessToken,
  cleanupTestEntities,
  postAs,
  withFailedDeliveries,
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
      it("writes an audit entry for a retry and a bulk retry", async () => {
        const { ep, ids } = await withFailedDeliveries(testToken, 3);

        expect(
          (
            await postAs(
              testToken,
              `/webhooks/${ep.id}/deliveries/${ids[0]}/retry`
            )
          ).status
        ).toBe(202);
        const bulk = await postAs(
          testToken,
          `/webhooks/${ep.id}/deliveries/retry`
        );
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
