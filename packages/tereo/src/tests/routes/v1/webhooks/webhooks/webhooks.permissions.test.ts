// @module-tag int
// @module-tag webhooks
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import axios from "axios";
import {
  getTestPrincipalToken,
  testOrgId,
} from "../../../../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  getTestOrgId,
  createTestWebhookEndpoint,
  cleanupTestEntities,
  WebhookEndpointResponse,
  PaginatedResponse,
} from "../../../../support/webhooks.js";

const get = <T>(path: string, token: string, headers = {}) =>
  axios.get<T>(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}`, ...headers },
    validateStatus: () => true,
  });

const listEndpoints = (query: string, token: string, headers = {}) =>
  get<PaginatedResponse<WebhookEndpointResponse>>(
    `/webhooks?limit=100&${query}`,
    token,
    headers
  );

const ids = (res: { data: { data: { id: string }[] } }) =>
  res.data.data.map((r) => r.id);

describe("GET /v1/webhooks/webhooks and POST /v1/webhooks/webhooks", () => {
  describe("Webhook Endpoint Management", () => {
    describe("POST /webhooks", () => {
      it("should return 401 without authentication", async () => {
        const response = await axios.post(
          `${BASE_URL}/webhooks`,
          {
            url: "https://example.com/webhook",
            eventTypes: ["test.event"],
          },
          {
            headers: { "Content-Type": "application/json" },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      });

      it("should return 403 without org_id in token", async () => {
        // Token with no organization
        const tokenNoOrg = await getTestAccessToken(undefined, null);

        const response = await axios.post(
          `${BASE_URL}/webhooks`,
          {
            url: "https://example.com/webhook",
            eventTypes: ["test.event"],
          },
          {
            headers: {
              Authorization: `Bearer ${tokenNoOrg}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      });
    });
  });

  describe("Webhook list filters and fields", () => {
    let token: string;

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("X-Organization-ID", () => {
      const otherOrg = testOrgId("other-org-1");
      let ownEndpoint: WebhookEndpointResponse;
      let otherEndpoint: WebhookEndpointResponse;

      beforeAll(async () => {
        ownEndpoint = await createTestWebhookEndpoint(token);
        const otherToken = await getTestAccessToken(undefined, "other-org-1");
        otherEndpoint = await createTestWebhookEndpoint(otherToken);
      });

      it("lets webhooks.admin read another organization's endpoints", async () => {
        const res = await listEndpoints("", token, {
          "X-Organization-ID": otherOrg,
        });
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(ids(res)).toContain(otherEndpoint.id);
        expect(ids(res)).not.toContain(ownEndpoint.id);

        const one = await get<WebhookEndpointResponse>(
          `/webhooks/${otherEndpoint.id}`,
          token,
          { "X-Organization-ID": otherOrg }
        );
        expect(one.status).toBe(HTTP_STATUS.OK);
      });

      it("is ignored for callers without webhooks.admin", async () => {
        const writer = await getTestPrincipalToken({
          organizationId: getTestOrgId(),
          permissions: ["webhooks.write"],
        });

        const res = await listEndpoints("", writer, {
          "X-Organization-ID": otherOrg,
        });
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(ids(res)).toContain(ownEndpoint.id);
        expect(ids(res)).not.toContain(otherEndpoint.id);

        const one = await get(`/webhooks/${otherEndpoint.id}`, writer, {
          "X-Organization-ID": otherOrg,
        });
        expect(one.status).toBe(HTTP_STATUS.NOT_FOUND);
      });

      it("returns 400 for a malformed id and 404 for an unknown organization", async () => {
        const malformed = await listEndpoints("", token, {
          "X-Organization-ID": "not-a-uuid",
        });
        expect(malformed.status).toBe(HTTP_STATUS.BAD_REQUEST);

        const unknown = await listEndpoints("", token, {
          "X-Organization-ID": "00000000-0000-7002-ffff-000000000000",
        });
        expect(unknown.status).toBe(HTTP_STATUS.NOT_FOUND);
      });
    });
  });
});
