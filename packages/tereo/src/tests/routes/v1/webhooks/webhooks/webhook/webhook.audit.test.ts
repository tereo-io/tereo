// @module-tag int
// @module-tag webhooks
import { updateWebhookEndpoint } from "../../../../../../routes/v1/webhooks/webhooks/webhook/controllers.js";
import { HEADER_VALUE_MASK } from "../../../../../../utils/webhookHeaders.js";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import db from "../../../../../../utils/db/index.js";
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

const MASK = HEADER_VALUE_MASK;

describe("/v1/webhooks/webhooks/:id", () => {
  describe("Webhook Endpoint Management", () => {
    let testToken: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("Custom Headers", () => {
      it("records a value-only header change in the audit entry, masked", async () => {
        const ep = await createTestWebhookEndpoint(testToken);
        await prisma.webhookEndpoint.update({
          where: { id: ep.id },
          data: { customHeaders: { "X-Api-Key": "old-key" } },
        });

        const response = await axios.patch(
          `${BASE_URL}/webhooks/${ep.id}`,
          { customHeaders: { "X-Api-Key": "new-key" } },
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );
        expect(response.status).toBe(HTTP_STATUS.OK);

        const entry = await prisma.auditLogEntry.findFirstOrThrow({
          where: {
            entityType: "WebhookEndpoint",
            entityId: ep.id,
            action: "UPDATE",
          },
          orderBy: { createdAt: "desc" },
        });
        expect(JSON.stringify(entry)).not.toContain("-key");
        expect(
          (entry.changes as Record<string, unknown>).customHeaders
        ).toEqual({
          old: { "X-Api-Key": MASK },
          new: { "X-Api-Key": MASK },
        });
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

    describe("POST /webhooks/:id/rotate-secret", () => {
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
    });

    describe("update audit entry", () => {
      it("never records a signing secret, even when one rotated mid-update", async () => {
        const ep = await createTestWebhookEndpoint(token);
        const stored = await db.webhookEndpoints.getById(ep.id);
        // The update read the endpoint just before a rotation committed.
        const read = vi
          .spyOn(db.webhookEndpoints, "getById")
          .mockResolvedValue({
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
});
