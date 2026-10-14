import { updateWebhookEndpoint } from "../../routes/v1/webhooks/webhooks/webhook/controllers.js";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openEndpointSecrets } from "../../utils/webhookSecrets.js";
import { signatureHeader } from "../../utils/webhookSigning.js";
import { getTestPrincipalToken } from "../utils/principals.js";
import { prisma } from "../../utils/db/prisma.js";
import type { Request, Response } from "express";
import db from "../../utils/db/index.js";
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
  PaginatedResponse,
  getTestOrgId,
  getTestUserId,
} from "./utils/test-helpers.js";

const NON_EXISTENT_UUID = "00000000-0000-7000-8000-000000000000";
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

    it("records the overlap in the audit entry", async () => {
      const ep = await createTestWebhookEndpoint(token);
      const rotate = await post(`/webhooks/${ep.id}/rotate-secret`);

      const entry = await prisma.auditLogEntry.findFirst({
        where: { entityId: ep.id, entityType: "WebhookEndpoint" },
        orderBy: { createdAt: "desc" },
      });
      expect(entry?.action).toBe("UPDATE");
      expect(entry?.metadata).toEqual({
        action: "rotate-secret",
        previousSecretExpiresAt: rotate.data.previousSecretExpiresAt,
      });
    });

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
      const response = await post(`/webhooks/${ep.id}/revoke-previous-secret`);
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.previousSecretExpiresAt).toBeNull();
    });

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

    it("returns 404 for an unknown endpoint", async () => {
      const response = await post(
        `/webhooks/${NON_EXISTENT_UUID}/revoke-previous-secret`
      );
      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("returns 409 for an archived endpoint", async () => {
      const ep = await createTestWebhookEndpoint(token);
      await post(`/webhooks/${ep.id}/archive`);
      const response = await post(`/webhooks/${ep.id}/revoke-previous-secret`);
      expect(response.status).toBe(HTTP_STATUS.CONFLICT);
    });
  });

  describe("hasDeliveries", () => {
    it("is false until a delivery exists, on get and list", async () => {
      const et = await createTestEventType(token);
      const ep = await createTestWebhookEndpoint(token, {
        eventTypes: [et.eventType],
      });
      expect(ep.hasDeliveries).toBe(false);
      expect((await getEndpoint(ep.id)).data.hasDeliveries).toBe(false);

      const emitted = await emitTestEvent(token, { eventType: et.eventType });
      expect(emitted.deliveriesCreated).toBe(1);

      expect((await getEndpoint(ep.id)).data.hasDeliveries).toBe(true);

      const list = await axios.get<PaginatedResponse<WebhookEndpointResponse>>(
        `${BASE_URL}/webhooks?filter[url]=${encodeURIComponent(ep.url)}&filter[url_op]=contains`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const listed = list.data.data.find((e) => e.id === ep.id);
      expect(listed?.hasDeliveries).toBe(true);
    });
  });

  describe("update audit entry", () => {
    it("never records a signing secret, even when one rotated mid-update", async () => {
      const ep = await createTestWebhookEndpoint(token);
      const stored = await db.webhookEndpoints.getById(ep.id);
      // The update read the endpoint just before a rotation committed.
      const read = vi.spyOn(db.webhookEndpoints, "getById").mockResolvedValue({
        ...stored,
        signingSecret: "a".repeat(64),
        previousSigningSecret: "b".repeat(64),
      });
      const req = {
        auth: {
          userId: getTestUserId(),
          email: null,
          permissions: ["webhooks.admin"],
        },
        organizationId: getTestOrgId(),
        params: { id: ep.id },
        body: { description: "renamed" },
      } as unknown as Request;
      const res = { json: vi.fn() } as unknown as Response;
      try {
        await updateWebhookEndpoint(req, res);
      } finally {
        read.mockRestore();
      }

      const entry = await prisma.auditLogEntry.findFirstOrThrow({
        where: {
          entityType: "WebhookEndpoint",
          entityId: ep.id,
          action: "UPDATE",
        },
        orderBy: { createdAt: "desc" },
      });
      const changes = entry.changes as Record<string, unknown>;
      expect(changes).toHaveProperty("description");
      expect(changes).not.toHaveProperty("signingSecret");
      expect(changes).not.toHaveProperty("previousSigningSecret");
      expect(JSON.stringify(changes)).not.toContain(stored.signingSecret);
    });
  });
});
