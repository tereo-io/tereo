// @module-tag unit
// @module-tag auth
import { describe, it, expect } from "vitest";
import {
  TokenRequestSchema,
  TokenRequestSchemaLoose,
} from "../../../../routes/oauth/token/schemas.js";

describe("POST /oauth/token", () => {
  describe("TokenRequestSchemaLoose", () => {
    it.each([
      ["a missing grant_type", { code: "some-code", client_id: "test-client" }],
      ["an empty body", {}],
    ])("rejects %s", (_label, input) => {
      const result = TokenRequestSchemaLoose.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual(["grant_type"]);
    });
  });

  describe("TokenRequestSchema", () => {
    it.each([
      [
        "a code_verifier outside the RFC 7636 alphabet",
        {
          grant_type: "authorization_code",
          client_id: "test-client",
          code: "x",
          redirect_uri: "http://localhost:3000/callback",
          code_verifier: `${"a".repeat(42)} `,
        },
        "code_verifier",
      ],
    ])("rejects %s", (_label, input, field) => {
      const result = TokenRequestSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual([field]);
    });
  });
});
