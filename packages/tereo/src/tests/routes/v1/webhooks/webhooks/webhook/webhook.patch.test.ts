// @module-tag int
// @module-tag webhooks
import { HEADER_VALUE_MASK } from "../../../../../../utils/webhookHeaders.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import db from "../../../../../../utils/db/index.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  createTestEventType,
  createTestWebhookEndpoint,
  cleanupTestEntities,
  generateUniqueId,
  WebhookEndpointResponse,
} from "../../../../../support/webhooks.js";

const MASK = HEADER_VALUE_MASK;

describe("PATCH /v1/webhooks/webhooks/:id", () => {
  describe("Webhook Endpoint Management", () => {
    let testToken: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("PATCH /webhooks/:id", () => {
      it("should update webhook url", async () => {
        const ep = await createTestWebhookEndpoint(testToken);
        const newUrl = `https://updated-${generateUniqueId()}.example.com/webhook`;

        const response = await axios.patch<WebhookEndpointResponse>(
          `${BASE_URL}/webhooks/${ep.id}`,
          { url: newUrl },
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.url).toBe(newUrl);
      });

      it("should update webhook description", async () => {
        const ep = await createTestWebhookEndpoint(testToken);

        const response = await axios.patch<WebhookEndpointResponse>(
          `${BASE_URL}/webhooks/${ep.id}`,
          { description: "Updated description" },
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.description).toBe("Updated description");
      });

      it("should update webhook eventTypes", async () => {
        const ep = await createTestWebhookEndpoint(testToken);
        const newEt = await createTestEventType(testToken);

        const response = await axios.patch<WebhookEndpointResponse>(
          `${BASE_URL}/webhooks/${ep.id}`,
          { eventTypes: [newEt.eventType] },
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.eventTypes).toContain(newEt.eventType);
      });

      it("should update webhook status", async () => {
        const ep = await createTestWebhookEndpoint(testToken);

        const response = await axios.patch<WebhookEndpointResponse>(
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

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.status).toBe("PAUSED");
      });

      it("should return masked secret in update response", async () => {
        const ep = await createTestWebhookEndpoint(testToken);

        const response = await axios.patch<WebhookEndpointResponse>(
          `${BASE_URL}/webhooks/${ep.id}`,
          { description: "Check secret masking" },
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.signingSecret).toContain("...");
      });
    });

    describe("Custom Headers", () => {
      it("should update custom headers via PATCH", async () => {
        const ep = await createTestWebhookEndpoint(testToken);

        const response = await axios.patch<WebhookEndpointResponse>(
          `${BASE_URL}/webhooks/${ep.id}`,
          {
            customHeaders: { "X-New-Header": "new-value" },
          },
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.customHeaders).toEqual({ "X-New-Header": MASK });
        const stored = await prisma.webhookEndpoint.findUniqueOrThrow({
          where: { id: ep.id },
        });
        expect(stored.customHeaders).toEqual({ "X-New-Header": "new-value" });
      });

      it("keeps a stored value when PATCH sends back its mask", async () => {
        const ep = await createTestWebhookEndpoint(testToken);
        await prisma.webhookEndpoint.update({
          where: { id: ep.id },
          data: {
            customHeaders: { "X-Api-Key": "secret-key", "X-Tenant": "t-1" },
          },
        });

        // What the admin UI sends after editing one header of the masked set.
        const response = await axios.patch<WebhookEndpointResponse>(
          `${BASE_URL}/webhooks/${ep.id}`,
          {
            customHeaders: {
              "X-Api-Key": MASK,
              "X-Tenant": "t-2",
              "X-Added": "new",
            },
          },
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.customHeaders).toEqual({
          "X-Api-Key": MASK,
          "X-Tenant": MASK,
          "X-Added": MASK,
        });
        const stored = await prisma.webhookEndpoint.findUniqueOrThrow({
          where: { id: ep.id },
        });
        expect(stored.customHeaders).toEqual({
          "X-Api-Key": "secret-key",
          "X-Tenant": "t-2",
          "X-Added": "new",
        });

        const entry = await prisma.auditLogEntry.findFirstOrThrow({
          where: {
            entityType: "WebhookEndpoint",
            entityId: ep.id,
            action: "UPDATE",
          },
          orderBy: { createdAt: "desc" },
        });
        expect(JSON.stringify(entry)).not.toContain("secret-key");
        expect(JSON.stringify(entry)).not.toContain("t-1");
        expect(JSON.stringify(entry)).not.toContain("t-2");
        expect(
          (entry.changes as Record<string, unknown>).customHeaders
        ).toEqual({
          old: { "X-Api-Key": MASK, "X-Tenant": MASK },
          new: { "X-Api-Key": MASK, "X-Tenant": MASK, "X-Added": MASK },
        });
      });

      it("keeps a stored value when the mask comes back under another case", async () => {
        const ep = await createTestWebhookEndpoint(testToken);
        await prisma.webhookEndpoint.update({
          where: { id: ep.id },
          data: { customHeaders: { "X-Api-Key": "secret-key" } },
        });

        const response = await axios.patch(
          `${BASE_URL}/webhooks/${ep.id}`,
          { customHeaders: { "x-api-key": MASK } },
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        const stored = await prisma.webhookEndpoint.findUniqueOrThrow({
          where: { id: ep.id },
        });
        expect(stored.customHeaders).toEqual({ "x-api-key": "secret-key" });
      });

      it("should clear custom headers by setting to null", async () => {
        const et = await createTestEventType(testToken);
        const uniqueId = generateUniqueId();

        const createResponse = await axios.post<WebhookEndpointResponse>(
          `${BASE_URL}/webhooks`,
          {
            url: `https://example.com/webhook/${uniqueId}`,
            eventTypes: [et.eventType],
            customHeaders: { "X-To-Remove": "value" },
          },
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        const patchResponse = await axios.patch<WebhookEndpointResponse>(
          `${BASE_URL}/webhooks/${createResponse.data.id}`,
          { customHeaders: null },
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(patchResponse.status).toBe(HTTP_STATUS.OK);
        expect(patchResponse.data.customHeaders).toBeNull();
      });
    });
  });

  describe("Auto-Disable Endpoints", () => {
    let testToken: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("re-enabling", () => {
      const patchStatus = (id: string, status: string) =>
        axios.patch(
          `${BASE_URL}/webhooks/${id}`,
          { status },
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

      it("resets consecutive failures when a DISABLED endpoint is set ACTIVE", async () => {
        const ep = await createTestWebhookEndpoint(testToken);
        await prisma.webhookEndpoint.update({
          where: { id: ep.id },
          data: { status: "DISABLED", consecutiveFailures: 5 },
        });

        const response = await patchStatus(ep.id, "ACTIVE");
        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(response.data.status).toBe("ACTIVE");

        const row = await prisma.webhookEndpoint.findUnique({
          where: { id: ep.id },
        });
        expect(row!.consecutiveFailures).toBe(0);

        // One more exhausted delivery no longer disables it.
        const next = await db.webhookEndpoints.incrementConsecutiveFailures(
          ep.id
        );
        expect(next.consecutiveFailures).toBe(1);
      });

      it("keeps the count when an already ACTIVE endpoint is set ACTIVE", async () => {
        const ep = await createTestWebhookEndpoint(testToken);
        await prisma.webhookEndpoint.update({
          where: { id: ep.id },
          data: { consecutiveFailures: 3 },
        });

        const response = await patchStatus(ep.id, "ACTIVE");
        expect(response.status).toBe(HTTP_STATUS.OK);

        const row = await prisma.webhookEndpoint.findUnique({
          where: { id: ep.id },
        });
        expect(row!.consecutiveFailures).toBe(3);
      });
    });
  });
});
