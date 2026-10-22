// @module-tag int
// @module-tag webhooks
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import db from "../../../utils/db/index.js";
import {
  getTestAccessToken,
  createTestWebhookEndpoint,
  cleanupTestEntities,
} from "../../support/webhooks.js";

describe("resetConsecutiveFailures and incrementConsecutiveFailures", () => {
  describe("Auto-Disable Endpoints", () => {
    let testToken: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("consecutiveFailures helpers", () => {
      it("should reset consecutive failures to 0", async () => {
        const ep = await createTestWebhookEndpoint(testToken);

        // Manually set consecutive failures
        await prisma.webhookEndpoint.update({
          where: { id: ep.id },
          data: { consecutiveFailures: 3 },
        });

        await db.webhookEndpoints.resetConsecutiveFailures(ep.id);

        const updated = await prisma.webhookEndpoint.findUnique({
          where: { id: ep.id },
        });
        expect(updated!.consecutiveFailures).toBe(0);
      });

      it("should increment consecutive failures by 1", async () => {
        const ep = await createTestWebhookEndpoint(testToken);

        const updated = await db.webhookEndpoints.incrementConsecutiveFailures(
          ep.id
        );
        expect(updated.consecutiveFailures).toBe(1);

        const updated2 = await db.webhookEndpoints.incrementConsecutiveFailures(
          ep.id
        );
        expect(updated2.consecutiveFailures).toBe(2);
      });

      // Disabling at the threshold is exercised through the delivery worker
      // in jobs/webhookDelivery.test.ts.
    });
  });
});
