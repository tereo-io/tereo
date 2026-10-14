import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  createTestWebhookEndpoint,
  cleanupTestEntities,
} from "./utils/test-helpers.js";

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
    // in deliveryWorker.test.ts.
  });

  describe("re-enabling", () => {
    const patchStatus = (id: string, status: string) =>
      axios.patch(
        `${BASE_URL}/webhooks/${id}`,
        { status },
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

    it("resets consecutive failures when a DISABLED endpoint is set ACTIVE", async () => {
      const ep = await createTestWebhookEndpoint(testToken);
      await prisma.webhookEndpoint.update({
        where: { id: ep.id },
        data: { status: "DISABLED", consecutiveFailures: 5 },
      });

      const response = await patchStatus(ep.id, "ACTIVE");
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.status).toBe("ACTIVE");

      const row = await prisma.webhookEndpoint.findUnique({
        where: { id: ep.id },
      });
      expect(row!.consecutiveFailures).toBe(0);

      // One more exhausted delivery no longer disables it.
      const next = await db.webhookEndpoints.incrementConsecutiveFailures(
        ep.id
      );
      expect(next.consecutiveFailures).toBe(1);
    });

    it("keeps the count when an already ACTIVE endpoint is set ACTIVE", async () => {
      const ep = await createTestWebhookEndpoint(testToken);
      await prisma.webhookEndpoint.update({
        where: { id: ep.id },
        data: { consecutiveFailures: 3 },
      });

      const response = await patchStatus(ep.id, "ACTIVE");
      expect(response.status).toBe(HTTP_STATUS.OK);

      const row = await prisma.webhookEndpoint.findUnique({
        where: { id: ep.id },
      });
      expect(row!.consecutiveFailures).toBe(3);
    });
  });
});
