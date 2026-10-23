// @module-tag unit
// @module-tag platform
import { CompleteSetupSchema } from "../../../../routes/v1/setup/schemas.js";
import { describe, it, expect } from "vitest";

const body = {
  token: "setup-token",
  admin: {
    email: "setup-admin@test.local",
    name: "Setup Admin",
    password: "SetupPassword123!",
  },
  organization: { name: "Acme", slug: "acme", code: "ACME01" },
};

describe("POST /v1/setup", () => {
  describe("CompleteSetupSchema", () => {
    it("accepts a complete body", () => {
      expect(CompleteSetupSchema.safeParse(body).success).toBe(true);
    });

    it.each([
      [
        "a password that is too short",
        { ...body, admin: { ...body.admin, password: "short" } },
        ["admin", "password"],
      ],
    ])("rejects %s", (_label, input, path) => {
      const result = CompleteSetupSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(path);
    });
  });
});
