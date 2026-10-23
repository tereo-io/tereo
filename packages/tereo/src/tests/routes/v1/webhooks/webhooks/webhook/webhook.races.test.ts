// @module-tag int
// @module-tag webhooks
// @module-tag race
import { updateWebhookEndpoint } from "../../../../../../routes/v1/webhooks/webhooks/webhook/controllers.js";
import { HEADER_VALUE_MASK } from "../../../../../../utils/webhookHeaders.js";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import db from "../../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import {
  getTestAccessToken,
  createTestWebhookEndpoint,
  cleanupTestEntities,
  getTestOrgId,
  getTestUserId,
} from "../../../../../support/webhooks.js";

describe("PATCH /v1/webhooks/webhooks/:id", () => {
  describe("PATCH masked custom headers vs a concurrent header change", () => {
    let token: string;
    beforeAll(async () => {
      token = await getTestAccessToken();
    });
    afterAll(async () => {
      await cleanupTestEntities();
    });

    it("keeps the value stored at write time, not a stale read", async () => {
      const ep = await createTestWebhookEndpoint(token);
      await prisma.webhookEndpoint.update({
        where: { id: ep.id },
        data: { customHeaders: { "X-Api-Key": "old-revoked-key" } },
      });
      const staleRead = await db.webhookEndpoints.getById(ep.id);

      // A concurrent PATCH rotates the key and commits after our read.
      await prisma.webhookEndpoint.update({
        where: { id: ep.id },
        data: { customHeaders: { "X-Api-Key": "new-key" } },
      });

      const read = vi
        .spyOn(db.webhookEndpoints, "getById")
        .mockResolvedValue(staleRead);
      const req = {
        auth: {
          userId: getTestUserId(),
          email: null,
          permissions: ["webhooks.admin"],
        },
        organizationId: getTestOrgId(),
        params: { id: ep.id },
        body: {
          description: "renamed",
          customHeaders: { "X-Api-Key": HEADER_VALUE_MASK },
        },
      } as unknown as Request;
      const res = { json: vi.fn() } as unknown as Response;
      try {
        await updateWebhookEndpoint(req, res);
      } finally {
        read.mockRestore();
      }

      const stored = await prisma.webhookEndpoint.findUniqueOrThrow({
        where: { id: ep.id },
      });
      expect(stored.customHeaders).toEqual({ "X-Api-Key": "new-key" });
    });
  });
});
