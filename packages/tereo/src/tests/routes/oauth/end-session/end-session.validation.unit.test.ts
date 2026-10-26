// @module-tag unit
// @module-tag auth
import { EndSessionRequestSchema } from "../../../../routes/oauth/end-session/schemas.js";
import { describe, it, expect } from "vitest";

describe("GET /oauth/end-session", () => {
  describe("EndSessionRequestSchema", () => {
    it.each([
      [
        "an over-long post_logout_redirect_uri",
        {
          client_id: "test-client",
          post_logout_redirect_uri: `http://localhost:3000/${"a".repeat(2100)}`,
        },
        "post_logout_redirect_uri",
      ],
    ])("rejects %s", (_label, input, field) => {
      const result = EndSessionRequestSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual([field]);
    });
  });
});
