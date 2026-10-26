// @module-tag unit
// @module-tag auth
import { CLIENT_SECRET_PATTERN } from "../../utils/secretRules.js";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  generateClientSecret,
  hashFlowToken,
  verifyClientSecret,
} from "../../utils/crypto.js";

const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const client = (
  clientSecret: string | null,
  previousSecretHash: string | null = null,
  previousSecretExpiresAt: Date | null = null
) => ({ clientSecret, previousSecretHash, previousSecretExpiresAt });

describe("generateClientSecret and verifyClientSecret", () => {
  it("generateClientSecret returns a formatted secret and its SHA-256 hash", () => {
    const { plainSecret, hashedSecret } = generateClientSecret();
    expect(plainSecret).toMatch(CLIENT_SECRET_PATTERN);
    expect(hashedSecret).toBe(hashFlowToken(plainSecret));
  });

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
