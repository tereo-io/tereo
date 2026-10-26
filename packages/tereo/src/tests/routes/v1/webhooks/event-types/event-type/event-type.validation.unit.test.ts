// @module-tag unit
// @module-tag webhooks
import { eventTypeParamSchema } from "../../../../../../routes/v1/webhooks/event-types/event-type/schemas.js";
import { describe, it, expect } from "vitest";

describe("/v1/webhooks/event-types/:eventType", () => {
  describe("eventTypeParamSchema", () => {
    it.each([
      ["a NUL in the event type", "a\u0000"],
      ["an event type over 100 characters", "a".repeat(101)],
    ])("rejects %s", (_label, eventType) => {
      expect(eventTypeParamSchema.safeParse({ eventType }).success).toBe(false);
    });

    it("accepts an event type of 100 characters", () => {
      const eventType = "a".repeat(100);
      expect(eventTypeParamSchema.safeParse({ eventType }).success).toBe(true);
    });
  });
});
