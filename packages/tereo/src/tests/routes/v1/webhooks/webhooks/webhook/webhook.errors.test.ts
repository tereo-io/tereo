// @module-tag int
// @module-tag webhooks
import { testWebhookEndpoint } from "../../../../../../routes/v1/webhooks/webhooks/webhook/controllers.js";
import { getWebhookDeliveryQueue } from "../../../../../../jobs/webhookQueues.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import type { Request, Response } from "express";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  getTestOrgId,
  createTestWebhookEndpoint,
  cleanupTestEntities,
  WebhookEndpointResponse,
  getTestUserId,
} from "../../../../../support/webhooks.js";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
  afterEach,
} from "vitest";

const NON_EXISTENT_UUID = "00000000-0000-7000-8000-000000000000";

/** A request as the auth and organization middleware leave it. */
const request = (params: Record<string, string>, body: unknown = {}) =>
  ({
    auth: {
      userId: getTestUserId(),
      email: null,
      permissions: ["webhooks.admin"],
    },
    organizationId: getTestOrgId(),
    params,
    body,
    query: {},
  }) as unknown as Request;

const response = () => {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
};

describe("/v1/webhooks/webhooks/:id", () => {
  describe("Webhook Endpoint Management", () => {
    let testToken: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("POST /webhooks/:id/archive + /restore", () => {
      it("409s on archiving an already-archived endpoint", async () => {
        const ep = await createTestWebhookEndpoint(testToken);
        await axios.post(
          `${BASE_URL}/webhooks/${ep.id}/archive`,
          {},
          { headers: { Authorization: `Bearer ${testToken}` } }
        );
        const response = await axios.post(
          `${BASE_URL}/webhooks/${ep.id}/archive`,
          {},
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );
        expect(response.status).toBe(409);
        expect(response.data.error).toBe("already_archived");
      });

      it("409s on restoring an endpoint that is not archived", async () => {
        const ep = await createTestWebhookEndpoint(testToken);
        const response = await axios.post(
          `${BASE_URL}/webhooks/${ep.id}/restore`,
          {},
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );
        expect(response.status).toBe(HTTP_STATUS.CONFLICT);
        expect(response.data.error).toBe("not_archived");
      });

      it("409s on PATCHing an archived endpoint (read-only)", async () => {
        const ep = await createTestWebhookEndpoint(testToken);
        await axios.post(
          `${BASE_URL}/webhooks/${ep.id}/archive`,
          {},
          { headers: { Authorization: `Bearer ${testToken}` } }
        );
        const response = await axios.patch(
          `${BASE_URL}/webhooks/${ep.id}`,
          { description: "nope" },
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );
        expect(response.status).toBe(409);
      });

      it("409s on rotate-secret and test for an archived endpoint", async () => {
        const ep = await createTestWebhookEndpoint(testToken);
        await axios.post(
          `${BASE_URL}/webhooks/${ep.id}/archive`,
          {},
          { headers: { Authorization: `Bearer ${testToken}` } }
        );
        const rotate = await axios.post(
          `${BASE_URL}/webhooks/${ep.id}/rotate-secret`,
          {},
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );
        expect(rotate.status).toBe(409);

        const test = await axios.post(
          `${BASE_URL}/webhooks/${ep.id}/test`,
          {},
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );
        expect(test.status).toBe(409);
      });
    });

    describe("POST /webhooks/:id/test", () => {
      it("should return 400 for PAUSED endpoint", async () => {
        const ep = await createTestWebhookEndpoint(testToken);

        // Pause the endpoint first
        await axios.patch(
          `${BASE_URL}/webhooks/${ep.id}`,
          { status: "PAUSED" },
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        const response = await axios.post(
          `${BASE_URL}/webhooks/${ep.id}/test`,
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

    describe("POST /webhooks/:id/revoke-previous-secret", () => {
      it("returns 404 for an unknown endpoint", async () => {
        const response = await post(
          `/webhooks/${NON_EXISTENT_UUID}/revoke-previous-secret`
        );
        expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      });

      it("returns 409 for an archived endpoint", async () => {
        const ep = await createTestWebhookEndpoint(token);
        await post(`/webhooks/${ep.id}/archive`);
        const response = await post(
          `/webhooks/${ep.id}/revoke-previous-secret`
        );
        expect(response.status).toBe(HTTP_STATUS.CONFLICT);
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

    it("test send returns 202 and writes one delivery", async () => {
      const ep = await createTestWebhookEndpoint(token);
      const add = failEnqueue();
      const res = response();

      await testWebhookEndpoint(
        request({ id: ep.id }),
        res as unknown as Response
      );

      expect(add).toHaveBeenCalled();
      expect(res.statusCode).toBe(202);
      const { deliveryId } = res.body as { deliveryId: string };
      const rows = await prisma.webhookDelivery.findMany({
        where: { webhookEndpointId: ep.id },
      });
      expect(rows.map((r) => r.id)).toEqual([deliveryId]);
      expect(rows[0].status).toBe("PENDING");
    });
  });
});
