// @module-tag int
// @module-tag webhooks
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  createTestWebhookEndpoint,
  cleanupTestEntities,
} from "../../../../../support/webhooks.js";

describe("DELETE /v1/webhooks/webhooks/:id", () => {
  describe("Webhook Endpoint Management", () => {
    let testToken: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("DELETE /webhooks/:id", () => {
      it("should hard delete a webhook endpoint with no deliveries (204, then 404)", async () => {
        const ep = await createTestWebhookEndpoint(testToken);

        const response = await axios.delete(`${BASE_URL}/webhooks/${ep.id}`, {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });
        expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);

        const getResponse = await axios.get(`${BASE_URL}/webhooks/${ep.id}`, {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });
        expect(getResponse.status).toBe(HTTP_STATUS.NOT_FOUND);
      });

      it("should 409 when the endpoint still has delivery history", async () => {
        const ep = await createTestWebhookEndpoint(testToken);
        // POST /test creates a WebhookDelivery row referencing the endpoint.
        const testResponse = await axios.post(
          `${BASE_URL}/webhooks/${ep.id}/test`,
          {},
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );
        expect(testResponse.status).toBe(HTTP_STATUS.ACCEPTED);

        const response = await axios.delete(`${BASE_URL}/webhooks/${ep.id}`, {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });
        expect(response.status).toBe(409);
      });
    });
  });
});
