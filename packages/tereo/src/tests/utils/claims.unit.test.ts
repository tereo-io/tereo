// @module-tag unit
// @module-tag auth
import { buildUserClaims } from "../../utils/claims.js";
import { describe, expect, it } from "vitest";

const user = {
  id: "u1",
  email: "a@test.local",
  updatedAt: new Date(),
  emailVerifiedAt: null as Date | null,
};

describe("buildUserClaims", () => {
  it("email_verified follows emailVerifiedAt", () => {
    expect(buildUserClaims(user, ["email"]).email_verified).toBe(false);
    expect(
      buildUserClaims({ ...user, emailVerifiedAt: new Date() }, ["email"])
        .email_verified
    ).toBe(true);
    expect(buildUserClaims(user, ["openid"])).not.toHaveProperty(
      "email_verified"
    );
  });
});
