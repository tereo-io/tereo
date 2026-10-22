// @module-tag unit
// @module-tag files
// @module-tag security
import { keyOf } from "../../utils/shareUnlockLimiter.js";
import { describe, it, expect } from "vitest";

const SECRET = "c0ffee-credential-value-1234567890";

describe("keyOf", () => {
  it("the share unlock limiter's key holds a hash of the share token", () => {
    expect(keyOf(SECRET, "10.0.0.1")).not.toContain(SECRET);
  });
});
