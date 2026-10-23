// @module-tag unit
// @module-tag webhooks
import { describe, it, expect } from "vitest";
import {
  bulkRetrySchema,
  getWebhookDeliveriesQuerySchema,
} from "../../../../../../../routes/v1/webhooks/webhooks/webhook/deliveries/schemas.js";

describe("/v1/webhooks/webhooks/:id/deliveries", () => {
  describe("getWebhookDeliveriesQuerySchema", () => {
    it.each([
      [
        "an invalid createdAt_gte date",
        { "filter[createdAt_gte]": "not-a-date" },
      ],
      [
        "an equality filter on createdAt",
        { "filter[createdAt]": "2026-01-01T00:00:00.000Z" },
      ],
      ["a NUL in filter[eventType]", { "filter[eventType]": "\u0000" }],
      [
        "a createdAt bound outside the years 1-9999",
        { "filter[createdAt_gte]": "-271821-04-20T00:00:00Z" },
      ],
    ])("rejects %s", (_label, query) => {
      expect(getWebhookDeliveriesQuerySchema.safeParse(query).success).toBe(
        false
      );
    });

    it("accepts a createdAt range", () => {
      const result = getWebhookDeliveriesQuerySchema.safeParse({
        "filter[createdAt_gte]": "2026-01-01T00:00:00.000Z",
        "filter[createdAt_lte]": "2026-02-01T00:00:00.000Z",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("bulkRetrySchema", () => {
    it.each([
      ["a fractional limit", { limit: 1.5 }],
      ["a string limit", { limit: "50" }],
      ["a boolean limit", { limit: true }],
      ["an exponent-string limit", { limit: "1e2" }],
      ["a NUL in eventType", { eventType: "a\u0000" }],
      ["a date outside the years 1-9999", { createdAfter: "-271821-04-20" }],
    ])("rejects %s", (_label, body) => {
      expect(bulkRetrySchema.safeParse(body).success).toBe(false);
    });

    it("names the NUL in eventType", () => {
      const result = bulkRetrySchema.safeParse({ eventType: "a\u0000" });
      expect(result.error?.issues[0]).toMatchObject({
        path: ["eventType"],
        message: "must not contain a NUL character",
      });
    });
  });
});
