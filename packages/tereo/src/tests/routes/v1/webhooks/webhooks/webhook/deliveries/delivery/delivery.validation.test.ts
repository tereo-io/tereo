// @module-tag int
// @module-tag webhooks
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  createTestEventType,
  createTestWebhookEndpoint,
  cleanupTestEntities,
} from "../../../../../../../support/webhooks.js";

describe("GET /v1/webhooks/webhooks/:id/deliveries/:deliveryId and POST /v1/webhooks/webhooks/:id/deliveries/:deliveryId/retry", () => {
  describe("Webhook Deliveries", () => {
    let testToken: string;
    let endpointId: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();

      const et = await createTestEventType(testToken);
      const ep = await createTestWebhookEndpoint(testToken, {
        eventTypes: [et.eventType],
      });
      endpointId = ep.id;
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("malformed input", () => {
      const call = (method: "get" | "post", path: string, data?: unknown) =>
        axios.request({
          method,
          url: `${BASE_URL}${path}`,
          data,
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });

      it("returns 400 for a non-uuid delivery id", async () => {
        for (const [method, path] of [
          ["get", `/webhooks/${endpointId}/deliveries/not-a-uuid`],
          ["post", `/webhooks/${endpointId}/deliveries/not-a-uuid/retry`],
        ] as const) {
          const response = await call(method, path, {});
          expect(response.status, `${method} ${path}`).toBe(
            HTTP_STATUS.BAD_REQUEST
          );
          expect(response.data.error).toBe("invalid_request");
        }
      });
    });
  });
});
