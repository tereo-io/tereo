// @module-tag int
// @module-tag webhooks
// @module-tag race
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getTestAccessToken,
  cleanupTestEntities,
  postAs,
  withFailedDeliveries,
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
      it("never resets the same delivery in two concurrent bulk retries", async () => {
        const { ep } = await withFailedDeliveries(testToken, 5);
        const path = `/webhooks/${ep.id}/deliveries/retry`;

        const responses = await Promise.all([
          postAs(testToken, path),
          postAs(testToken, path),
        ]);

        expect(responses.map((r) => r.status)).toEqual([202, 202]);
        const total = responses.reduce((n, r) => n + r.data.retriedCount, 0);
        expect(total).toBe(5);
      });
    });
  });
});
