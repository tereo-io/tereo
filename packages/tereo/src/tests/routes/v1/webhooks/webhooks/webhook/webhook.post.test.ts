// @module-tag int
// @module-tag webhooks
import { openEndpointSecrets } from "../../../../../../utils/webhookSecrets.js";
import { signatureHeader } from "../../../../../../utils/webhookSigning.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import db from "../../../../../../utils/db/index.js";
import { createHmac } from "crypto";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  createTestEventType,
  createTestWebhookEndpoint,
  cleanupTestEntities,
  emitTestEvent,
  WebhookEndpointResponse,
} from "../../../../../support/webhooks.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const sign = (secret: string, timestamp: number, body: string) =>
  `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

/** The X-Webhook-Signature value the delivery job would send right now. */
const deliveredSignatures = async (endpointId: string) => {
  const endpoint = await db.webhookEndpoints.getById(endpointId);
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ hello: "world" });
  return {
    timestamp,
    body,
    values: signatureHeader(
      await openEndpointSecrets(endpoint),
      timestamp,
      body
    ).split(","),
  };
};

describe("POST /v1/webhooks/webhooks/:id/archive, /restore, /rotate-secret, /revoke-previous-secret and /test", () => {
  describe("Webhook Endpoint Management", () => {
    let testToken: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("POST /webhooks/:id/archive + /restore", () => {
      it("archives an endpoint, hides it from the default list, then restores it", async () => {
        const ep = await createTestWebhookEndpoint(testToken);

        const archiveResponse = await axios.post<WebhookEndpointResponse>(
          `${BASE_URL}/webhooks/${ep.id}/archive`,
          {},
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );
        expect(archiveResponse.status).toBe(HTTP_STATUS.OK);
        expect(archiveResponse.data.archivedAt).not.toBeNull();

        // By-id GET still returns the archived endpoint.
        const getResponse = await axios.get<WebhookEndpointResponse>(
          `${BASE_URL}/webhooks/${ep.id}`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );
        expect(getResponse.status).toBe(HTTP_STATUS.OK);
        expect(getResponse.data.archivedAt).not.toBeNull();

        // Default list excludes it; includeArchived surfaces it.
        const defaultList = await axios.get<{
          data: WebhookEndpointResponse[];
        }>(`${BASE_URL}/webhooks?limit=100`, {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });
        expect(defaultList.data.data.some((e) => e.id === ep.id)).toBe(false);

        const archivedList = await axios.get<{
          data: WebhookEndpointResponse[];
        }>(`${BASE_URL}/webhooks?limit=100&includeArchived=true`, {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });
        expect(archivedList.data.data.some((e) => e.id === ep.id)).toBe(true);

        const restoreResponse = await axios.post<WebhookEndpointResponse>(
          `${BASE_URL}/webhooks/${ep.id}/restore`,
          {},
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );
        expect(restoreResponse.status).toBe(HTTP_STATUS.OK);
        expect(restoreResponse.data.archivedAt).toBeNull();
      });

      it("excludes an archived-but-ACTIVE endpoint from event fan-out", async () => {
        const et = await createTestEventType(testToken);
        const ep = await createTestWebhookEndpoint(testToken, {
          eventTypes: [et.eventType],
        });
        expect(ep.status).toBe("ACTIVE");

        // Baseline: the ACTIVE endpoint receives the event.
        const before = await emitTestEvent(testToken, {
          eventType: et.eventType,
        });
        expect(before.deliveriesCreated).toBe(1);

        // Archive (status stays ACTIVE) — fan-out must now skip it.
        await axios.post(
          `${BASE_URL}/webhooks/${ep.id}/archive`,
          {},
          { headers: { Authorization: `Bearer ${testToken}` } }
        );
        const after = await emitTestEvent(testToken, {
          eventType: et.eventType,
        });
        expect(after.deliveriesCreated).toBe(0);
      });
    });

    describe("POST /webhooks/:id/rotate-secret", () => {
      it("should rotate the signing secret", async () => {
        const ep = await createTestWebhookEndpoint(testToken);
        const originalSecret = ep.signingSecret;

        const response = await axios.post<WebhookEndpointResponse>(
          `${BASE_URL}/webhooks/${ep.id}/rotate-secret`,
          {},
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        // Full new secret should be returned
        expect(response.data.signingSecret).toBeDefined();
        expect(response.data.signingSecret.length).toBeGreaterThan(8);
        expect(response.data.signingSecret).not.toContain("...");
        // New secret should be different from original
        expect(response.data.signingSecret).not.toBe(originalSecret);
      });
    });

    describe("POST /webhooks/:id/test", () => {
      it("should send a test delivery and return 202 with deliveryId", async () => {
        const ep = await createTestWebhookEndpoint(testToken);

        const response = await axios.post<{ deliveryId: string }>(
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

        expect(response.status).toBe(HTTP_STATUS.ACCEPTED);
        expect(response.data.deliveryId).toBeDefined();

        // Verify the delivery was created with webhook.test event type
        const delivery = await prisma.webhookDelivery.findUnique({
          where: { id: response.data.deliveryId },
        });
        expect(delivery).not.toBeNull();
        expect(delivery!.eventType).toBe("webhook.test");
        expect(delivery!.webhookEndpointId).toBe(ep.id);
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
      it("keeps the old secret signing alongside the new one for 24 hours", async () => {
        const ep = await createTestWebhookEndpoint(token);
        expect(ep.previousSecretExpiresAt).toBeNull();

        const before = Date.now();
        const rotate = await post(`/webhooks/${ep.id}/rotate-secret`);
        expect(rotate.status).toBe(HTTP_STATUS.OK);
        const newSecret = rotate.data.signingSecret;
        expect(newSecret).not.toBe(ep.signingSecret);
        expect(newSecret).not.toContain("...");
        expect(rotate.data).not.toHaveProperty("previousSigningSecret");

        const expiresAt = new Date(
          rotate.data.previousSecretExpiresAt!
        ).getTime();
        expect(expiresAt).toBeGreaterThanOrEqual(before + DAY_MS - 1000);
        expect(expiresAt).toBeLessThanOrEqual(Date.now() + DAY_MS + 1000);

        const { timestamp, body, values } = await deliveredSignatures(ep.id);
        expect(values).toEqual([
          sign(newSecret, timestamp, body),
          sign(ep.signingSecret, timestamp, body),
        ]);

        const got = await getEndpoint(ep.id);
        expect(got.data.previousSecretExpiresAt).toBe(
          rotate.data.previousSecretExpiresAt
        );
        expect(got.data.signingSecret).toBe(newSecret.slice(0, 8) + "...");
        expect(got.data).not.toHaveProperty("previousSigningSecret");
      });

      it("signs with a single value when no rotation is in progress", async () => {
        const ep = await createTestWebhookEndpoint(token);
        const { timestamp, body, values } = await deliveredSignatures(ep.id);
        expect(values).toEqual([sign(ep.signingSecret, timestamp, body)]);
      });

      it("keeps only the most recently replaced secret on a second rotation", async () => {
        const ep = await createTestWebhookEndpoint(token);
        const first = await post(`/webhooks/${ep.id}/rotate-secret`);
        const second = await post(`/webhooks/${ep.id}/rotate-secret`);
        expect(second.status).toBe(HTTP_STATUS.OK);

        const { timestamp, body, values } = await deliveredSignatures(ep.id);
        expect(values).toEqual([
          sign(second.data.signingSecret, timestamp, body),
          sign(first.data.signingSecret, timestamp, body),
        ]);
      });

      it("stops signing with the old secret once the overlap has expired", async () => {
        const ep = await createTestWebhookEndpoint(token);
        const rotate = await post(`/webhooks/${ep.id}/rotate-secret`);
        await prisma.webhookEndpoint.update({
          where: { id: ep.id },
          data: { previousSecretExpiresAt: new Date(Date.now() - 1000) },
        });

        const { timestamp, body, values } = await deliveredSignatures(ep.id);
        expect(values).toEqual([
          sign(rotate.data.signingSecret, timestamp, body),
        ]);

        const got = await getEndpoint(ep.id);
        expect(got.data.previousSecretExpiresAt).toBeNull();
      });
    });

    describe("POST /webhooks/:id/revoke-previous-secret", () => {
      it("ends the overlap: only the new secret signs", async () => {
        const ep = await createTestWebhookEndpoint(token);
        const rotate = await post(`/webhooks/${ep.id}/rotate-secret`);

        const revoke = await post(`/webhooks/${ep.id}/revoke-previous-secret`);
        expect(revoke.status).toBe(HTTP_STATUS.OK);
        expect(revoke.data.previousSecretExpiresAt).toBeNull();
        expect(revoke.data.signingSecret).toBe(
          rotate.data.signingSecret.slice(0, 8) + "..."
        );

        const { timestamp, body, values } = await deliveredSignatures(ep.id);
        expect(values).toEqual([
          sign(rotate.data.signingSecret, timestamp, body),
        ]);

        const row = await prisma.webhookEndpoint.findUnique({
          where: { id: ep.id },
        });
        expect(row?.previousSigningSecret).toBeNull();
        expect(row?.previousSecretExpiresAt).toBeNull();

        const entry = await prisma.auditLogEntry.findFirst({
          where: { entityId: ep.id, entityType: "WebhookEndpoint" },
          orderBy: { createdAt: "desc" },
        });
        expect(entry?.metadata).toEqual({ action: "revoke-previous-secret" });
      });

      it("succeeds when there is no previous secret", async () => {
        const ep = await createTestWebhookEndpoint(token);
        const response = await post(
          `/webhooks/${ep.id}/revoke-previous-secret`
        );
        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.previousSecretExpiresAt).toBeNull();
      });
    });
  });
});
