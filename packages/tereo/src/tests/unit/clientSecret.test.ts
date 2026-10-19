import { rotatedSecretFields } from "../../utils/clients.js";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import env from "../../env.js";
import {
  generateClientSecret,
  verifyClientSecret,
} from "../../utils/crypto.js";

const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const client = (
  clientSecret: string | null,
  previousSecretHash: string | null = null,
  previousSecretExpiresAt: Date | null = null
) => ({ clientSecret, previousSecretHash, previousSecretExpiresAt });

describe("client secrets", () => {
  it("are stored as the SHA-256 hex of the plain secret", () => {
    const { plainSecret, hashedSecret } = generateClientSecret();
    expect(plainSecret).toMatch(/^tereo_sk_[A-Za-z0-9_-]{43}$/);
    expect(hashedSecret).toBe(sha256Hex(plainSecret));
  });

  it("verify the right secret and refuse a wrong one", () => {
    const { plainSecret, hashedSecret } = generateClientSecret();
    expect(verifyClientSecret(client(hashedSecret), plainSecret)).toBe(true);
    expect(verifyClientSecret(client(hashedSecret), `${plainSecret}x`)).toBe(
      false
    );
  });

  it("accept the previous secret only until it expires", () => {
    const current = generateClientSecret();
    const previous = generateClientSecret();
    const live = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 1);
    expect(
      verifyClientSecret(
        client(current.hashedSecret, previous.hashedSecret, live),
        previous.plainSecret
      )
    ).toBe(true);
    expect(
      verifyClientSecret(
        client(current.hashedSecret, previous.hashedSecret, past),
        previous.plainSecret
      )
    ).toBe(false);
  });

  it("refuse rather than throw on a malformed stored hash", () => {
    expect(verifyClientSecret(client("abcd"), "abcd")).toBe(false);
    expect(verifyClientSecret(client("not-hex"), "x")).toBe(false);
  });
});

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
