// @module-tag unit
// @module-tag auth
import { rotatedSecretFields } from "../../utils/clients.js";
import { describe, expect, it } from "vitest";
import env from "../../env.js";

describe("rotatedSecretFields", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const withOverlap = <T>(hours: number, run: () => T): T => {
    const saved = env.SERVICE_SECRET_OVERLAP_HOURS;
    env.SERVICE_SECRET_OVERLAP_HOURS = hours;
    try {
      return run();
    } finally {
      env.SERVICE_SECRET_OVERLAP_HOURS = saved;
    }
  };

  it("keeps the replaced secret as the previous one and retires the one it pushes out", () => {
    const fields = withOverlap(24, () =>
      rotatedSecretFields(
        {
          clientSecret: "b",
          previousSecretHash: "a",
          retiredSecretHashes: ["z"],
        },
        "c",
        now
      )
    );
    expect(fields).toEqual({
      clientSecret: "c",
      previousSecretHash: "b",
      previousSecretExpiresAt: new Date("2026-10-20T12:00:00Z"),
      retiredSecretHashes: ["z", "a"],
    });
  });

  it("retires the replaced secret at once without an overlap", () => {
    const fields = withOverlap(0, () =>
      rotatedSecretFields(
        {
          clientSecret: "b",
          previousSecretHash: "a",
          retiredSecretHashes: ["a"],
        },
        "c",
        now
      )
    );
    expect(fields).toEqual({
      clientSecret: "c",
      previousSecretHash: null,
      previousSecretExpiresAt: null,
      retiredSecretHashes: ["a", "b"],
    });
  });

  it("retires nothing for a client that had no secret", () => {
    const fields = withOverlap(24, () =>
      rotatedSecretFields(
        {
          clientSecret: null,
          previousSecretHash: null,
          retiredSecretHashes: [],
        },
        "a",
        now
      )
    );
    expect(fields.retiredSecretHashes).toEqual([]);
    expect(fields.previousSecretHash).toBeNull();
  });
});
