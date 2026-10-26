// @module-tag unit
// @module-tag platform
import { openRowSecret, sealRowSecret } from "../../utils/sealedSecrets.js";
import { currentKek } from "../../utils/keys.js";
import { describe, expect, it } from "vitest";

describe("sealRowSecret and openRowSecret", () => {
  it("round-trips without resealing", async () => {
    const sealed = await sealRowSecret("test-row:1", "hunter2");

    expect(sealed).not.toContain("hunter2");
    await expect(openRowSecret("test-row:1", sealed)).resolves.toEqual({
      value: "hunter2",
      resealed: null,
    });
  });

  it("refuses a value moved to another row", async () => {
    const sealed = await sealRowSecret("test-row:1", "hunter2");

    await expect(openRowSecret("test-row:2", sealed)).rejects.toThrow();
  });

  it("reseals a value not sealed under the current KEK", async () => {
    const opened = await openRowSecret("test-row:1", "hunter2");

    expect(opened.value).toBe("hunter2");
    expect(opened.resealed).toMatch(new RegExp(`^kek1:${currentKek().id}:`));
    await expect(
      openRowSecret("test-row:1", opened.resealed!)
    ).resolves.toEqual({ value: "hunter2", resealed: null });
  });
});
