// @module-tag unit
// @module-tag auth
import { IntrospectRequestSchema } from "../../../../routes/oauth/introspect/schemas.js";
import { describe, it, expect } from "vitest";

describe("POST /oauth/introspect", () => {
  describe("IntrospectRequestSchema", () => {
    it.each([["an empty token", { token: "" }, "token"]])(
      "rejects %s",
      (_label, input, field) => {
        const result = IntrospectRequestSchema.safeParse(input);
        expect(result.success).toBe(false);
        expect(result.error?.issues[0].path).toEqual([field]);
      }
    );
  });
});
