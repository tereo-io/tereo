// @module-tag unit
// @module-tag auth
import { EVENT_TYPES } from "../../definitions/eventTypes.js";
import { describe, expect, it } from "vitest";

describe("branding event read permissions", () => {
  it("gates grant events on branding.admin and the rest on branding.read", () => {
    const expected: Record<string, string> = {
      "auth.branding.grant-added": "branding.admin",
      "auth.branding.grant-revoked": "branding.admin",
      "auth.branding.updated": "branding.read",
      "auth.branding.deleted": "branding.read",
    };
    for (const [eventType, readPermission] of Object.entries(expected)) {
      const def = EVENT_TYPES.find((e) => e.eventType === eventType);
      expect(def, eventType).toBeDefined();
      expect(def?.readPermission).toBe(readPermission);
    }
  });
});
