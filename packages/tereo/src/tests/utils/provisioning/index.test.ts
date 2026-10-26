// @module-tag int
// @module-tag provisioning
import { provision } from "../../../utils/provisioning/index.js";
import { describe, it, expect } from "vitest";

describe("provision", () => {
  it("does nothing without PROVISIONING_PATH", async () => {
    await expect(provision()).resolves.toBeNull();
  });
});
