// @module-tag int
// @module-tag webhooks
import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  createTestEventType,
  createTestWebhookEndpoint,
  cleanupTestEntities,
  WebhookEndpointResponse,
} from "../../../../../support/webhooks.js";

describe("/v1/webhooks/webhooks/:id", () => {
  describe("Webhook Endpoint Management", () => {
    let testToken: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("GET /webhooks/:id", () => {
      it("should return 404 for endpoint belonging to different client", async () => {
        const ep = await createTestWebhookEndpoint(testToken);

        // Use a token with a different org
        const otherToken = await getTestAccessToken(
          "00000000-0000-7001-0000-000000000002",
          "other-org-1"
        );

        const response = await axios.get(`${BASE_URL}/webhooks/${ep.id}`, {
          headers: { Authorization: `Bearer ${otherToken}` },
          validateStatus: () => true,
        });

        expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      });
    });

    describe("PATCH /webhooks/:id", () => {
      it("should return 404 for endpoint belonging to different client", async () => {
        const ep = await createTestWebhookEndpoint(testToken);
        const otherToken = await getTestAccessToken(
          "00000000-0000-7001-0000-000000000002",
          "other-org-1"
        );

        const response = await axios.patch(
          `${BASE_URL}/webhooks/${ep.id}`,
          { description: "Should fail" },
          {
            headers: {
              Authorization: `Bearer ${otherToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      });
    });

    describe("DELETE /webhooks/:id", () => {
      it("should return 404 for endpoint belonging to different client", async () => {
        const ep = await createTestWebhookEndpoint(testToken);
        const otherToken = await getTestAccessToken(
          "00000000-0000-7001-0000-000000000002",
          "other-org-1"
        );

        const response = await axios.delete(`${BASE_URL}/webhooks/${ep.id}`, {
          headers: { Authorization: `Bearer ${otherToken}` },
          validateStatus: () => true,
        });

        expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      });
    });

    describe("POST /webhooks/:id/rotate-secret", () => {
      it("should return 404 for endpoint belonging to different client", async () => {
        const ep = await createTestWebhookEndpoint(testToken);
        const otherToken = await getTestAccessToken(
          "00000000-0000-7001-0000-000000000002",
          "other-org-1"
        );

        const response = await axios.post(
          `${BASE_URL}/webhooks/${ep.id}/rotate-secret`,
          {},
          {
            headers: {
              Authorization: `Bearer ${otherToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      });
    });

    describe("POST /webhooks/:id/test", () => {
      it("should return 404 for cross-tenant test", async () => {
        const ep = await createTestWebhookEndpoint(testToken);
        const otherToken = await getTestAccessToken(
          "00000000-0000-7001-0000-000000000002",
          "other-org-1"
        );

        const response = await axios.post(
          `${BASE_URL}/webhooks/${ep.id}/test`,
          {},
          {
            headers: {
              Authorization: `Bearer ${otherToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      });
    });
  });

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

    describe("GET /webhooks/:id/stats", () => {
      it("should return 404 for cross-tenant stats", async () => {
        const otherToken = await getTestAccessToken(
          "00000000-0000-7001-0000-000000000002",
          "other-org-1"
        );

        const response = await axios.get(
          `${BASE_URL}/webhooks/${endpointId}/stats`,
          {
            headers: { Authorization: `Bearer ${otherToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      });
    });
  });

  describe("Webhook signing secret rotation", () => {
    let token: string;

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    const post = (path: string, authToken = token) =>
      axios.post<WebhookEndpointResponse>(
        `${BASE_URL}${path}`,
        {},
        {
          headers: { Authorization: `Bearer ${authToken}` },
          validateStatus: () => true,
        }
      );

    const getEndpoint = (id: string) =>
      axios.get<WebhookEndpointResponse & Record<string, unknown>>(
        `${BASE_URL}/webhooks/${id}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

    describe("POST /webhooks/:id/rotate-secret", () => {
      it("returns 403 without webhooks.admin", async () => {
        const ep = await createTestWebhookEndpoint(token);
        const writeToken = await getTestPrincipalToken({
          organizationId: "00000000-0000-7002-0000-000000000001",
          permissions: ["webhooks.delete"],
        });
        const response = await post(
          `/webhooks/${ep.id}/rotate-secret`,
          writeToken
        );
        expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      });
    });

    describe("POST /webhooks/:id/revoke-previous-secret", () => {
      it("returns 403 without webhooks.admin", async () => {
        const ep = await createTestWebhookEndpoint(token);
        await post(`/webhooks/${ep.id}/rotate-secret`);
        const deleteToken = await getTestPrincipalToken({
          organizationId: "00000000-0000-7002-0000-000000000001",
          permissions: ["webhooks.delete"],
        });

        const response = await post(
          `/webhooks/${ep.id}/revoke-previous-secret`,
          deleteToken
        );
        expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);

        const got = await getEndpoint(ep.id);
        expect(got.data.previousSecretExpiresAt).not.toBeNull();
      });

      it("returns 404 for an endpoint in another organization", async () => {
        const ep = await createTestWebhookEndpoint(token);
        const otherToken = await getTestAccessToken(
          "00000000-0000-7001-0000-000000000002",
          "other-org-1"
        );
        const response = await post(
          `/webhooks/${ep.id}/revoke-previous-secret`,
          otherToken
        );
        expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      });

      it("returns 401 without a token", async () => {
        const ep = await createTestWebhookEndpoint(token);
        const response = await axios.post(
          `${BASE_URL}/webhooks/${ep.id}/revoke-previous-secret`,
          {},
          { validateStatus: () => true }
        );
        expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      });
    });
  });
});
