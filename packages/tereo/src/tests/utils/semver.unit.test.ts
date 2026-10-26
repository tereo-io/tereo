// @module-tag unit
// @module-tag provisioning
import { compareSemver, SEMVER_PATTERN } from "../../utils/semver.js";
import { describe, expect, it } from "vitest";

describe("compareSemver", () => {
  it("orders versions as semver does", () => {
    // Ascending, from the semver 2.0 precedence example and around it.
    const ordered = [
      "0.9.9",
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1",
      "1.2.0",
      "1.10.0",
      "2.0.0",
    ];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) {
        expect(compareSemver(ordered[i], ordered[j]), `${i} ${j}`).toBe(
          Math.sign(i - j)
        );
      }
    }
  });

  it("accepts MAJOR.MINOR.PATCH with an optional prerelease, nothing else", () => {
    for (const ok of ["0.0.0", "1.2.3", "10.20.30-rc.1", "1.0.0-x-y.7z"]) {
      expect(SEMVER_PATTERN.test(ok), ok).toBe(true);
    }
    for (const bad of [
      "1.2",
      "v1.2.3",
      "01.2.3",
      "1.2.3-01",
      "1.2.3+b",
      "1.2.3-",
    ]) {
      expect(SEMVER_PATTERN.test(bad), bad).toBe(false);
    }
  });
});
