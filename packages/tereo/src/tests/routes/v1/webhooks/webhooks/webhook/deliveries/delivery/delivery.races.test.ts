// @module-tag int
// @module-tag webhooks
// @module-tag race
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  HTTP_STATUS,
  getTestAccessToken,
  cleanupTestEntities,
  postAs,
  withFailedDeliveries,
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
      it("resets a delivery once when two retries race", async () => {
        const { ep, ids } = await withFailedDeliveries(testToken, 1);
        const path = `/webhooks/${ep.id}/deliveries/${ids[0]}/retry`;

        const responses = await Promise.all([
          postAs(testToken, path),
          postAs(testToken, path),
        ]);

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
