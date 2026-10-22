// @module-tag unit
// @module-tag notifications
import { CreateConnectionSchema } from "../../../../../../routes/v1/admin/notifications/connections/schemas.js";
import { describe, it, expect } from "vitest";

const payload = (over: Record<string, unknown> = {}) => ({
  channel: "email",
  slug: "main",
  displayName: "Main",
  settings: {},
  ...over,
});

describe("POST /v1/admin/notifications/connections", () => {
  describe("CreateConnectionSchema", () => {
    it.each([
      ["an unknown channel", { channel: "sms" }, "channel"],
      ["a bad slug", { slug: "Bad Slug" }, "slug"],
    ])("rejects %s", (_name, over, path) => {
      const result = CreateConnectionSchema.safeParse(payload(over));
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((i) => i.path.join("."))).toEqual([path]);
    });

    it("accepts a valid payload", () => {
      expect(CreateConnectionSchema.safeParse(payload()).success).toBe(true);
    });
  });
});
