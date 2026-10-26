// @module-tag unit
// @module-tag auth
import { describe, it, expect } from "vitest";
import {
  ConsentGetSchema,
  ConsentSubmitSchema,
} from "../../../../routes/oauth/consent/schemas.js";

describe("GET /oauth/consent", () => {
  describe("ConsentGetSchema", () => {
    it.each([["an empty session parameter", { session: "" }, "session"]])(
      "rejects %s",
      (_label, input, field) => {
        const result = ConsentGetSchema.safeParse(input);
        expect(result.success).toBe(false);
        expect(result.error?.issues[0].path).toEqual([field]);
      }
    );
  });
});

describe("POST /oauth/consent", () => {
  describe("ConsentSubmitSchema", () => {
    it.each([
      ["a missing approved field", { session_token: "some-token" }, "approved"],
    ])("rejects %s", (_label, input, field) => {
      const result = ConsentSubmitSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual([field]);
    });
  });
});
