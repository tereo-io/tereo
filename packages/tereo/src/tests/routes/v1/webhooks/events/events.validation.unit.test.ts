// @module-tag unit
// @module-tag webhooks
import { describe, it, expect } from "vitest";
import {
  batchEmitEventSchema,
  emitEventSchema,
} from "../../../../../routes/v1/webhooks/events/schemas.js";

const event = {
  organizationId: "00000000-0000-7002-8000-000000000001",
  eventType: "test.event",
  entityType: "TestEntity",
  entityId: "test-entity-1",
  data: { k: "v" },
};

describe("/v1/webhooks/events", () => {
  describe("emitEventSchema", () => {
    it("rejects a body missing organizationId, entityType, entityId and data", () => {
      const result = emitEventSchema.safeParse({ eventType: "test.event" });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path[0]).sort()).toEqual(
        ["data", "entityId", "entityType", "organizationId"]
      );
    });

    it.each([
      ["a NUL in eventType", { eventType: "a\u0000" }],
      ["a NUL in entityType", { entityType: "a\u0000" }],
      ["a NUL in entityId", { entityId: "a\u0000" }],
      ["a NUL in data", { data: { k: ["\u0000"] } }],
      ["a NUL in a data key", { data: { "k\u0000": 1 } }],
      ["an entityId over 500 characters", { entityId: "e".repeat(501) }],
      ["data over 256 KiB as JSON", { data: { k: "x".repeat(256 * 1024) } }],
    ])("rejects %s", (_label, fields) => {
      expect(emitEventSchema.safeParse({ ...event, ...fields }).success).toBe(
        false
      );
    });
  });

  describe("batchEmitEventSchema", () => {
    it("rejects an empty events array", () => {
      expect(batchEmitEventSchema.safeParse({ events: [] }).success).toBe(
        false
      );
    });

    it("rejects more than 100 events", () => {
      const events = Array.from({ length: 101 }, (_, i) => ({
        ...event,
        eventType: `test.event.${i}`,
        entityId: `entity-${i}`,
      }));
      expect(batchEmitEventSchema.safeParse({ events }).success).toBe(false);
    });

    it("accepts exactly 100 events", () => {
      const events = Array.from({ length: 100 }, () => event);
      expect(batchEmitEventSchema.safeParse({ events }).success).toBe(true);
    });

    it.each([
      ["a NUL in eventType", { eventType: "a\u0000" }],
      ["a NUL in entityType", { entityType: "a\u0000" }],
      ["a NUL in entityId", { entityId: "a\u0000" }],
      ["a NUL in data", { data: { k: ["\u0000"] } }],
      ["a NUL in a data key", { data: { "k\u0000": 1 } }],
      ["an entityId over 500 characters", { entityId: "e".repeat(501) }],
      ["data over 256 KiB as JSON", { data: { k: "x".repeat(256 * 1024) } }],
    ])("rejects an event with %s", (_label, fields) => {
      const events = [{ ...event, ...fields }];
      expect(batchEmitEventSchema.safeParse({ events }).success).toBe(false);
    });
  });
});
