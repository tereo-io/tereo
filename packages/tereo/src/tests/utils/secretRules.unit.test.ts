// @module-tag unit
// @module-tag auth
import { generateClientSecret, hashFlowToken } from "../../utils/crypto.js";
import { describe, expect, it } from "vitest";
import {
  CLIENT_SECRET_PATTERN,
  newClientSecretValue,
  secretStrengthProblem,
} from "../../utils/secretRules.js";

describe("client secret rules", () => {
  it("generates secrets in the documented format", () => {
    for (let i = 0; i < 100; i++)
      expect(newClientSecretValue()).toMatch(CLIENT_SECRET_PATTERN);
  });

  it("generateClientSecret returns a formatted secret and its SHA-256 hash", () => {
    const { plainSecret, hashedSecret } = generateClientSecret();
    expect(plainSecret).toMatch(CLIENT_SECRET_PATTERN);
    expect(hashedSecret).toBe(hashFlowToken(plainSecret));
  });

  it("accepts generated secrets", () => {
    for (let i = 0; i < 1000; i++)
      expect(secretStrengthProblem(newClientSecretValue())).toBeNull();
  });

  it.each([
    ["no prefix", "x".repeat(52)],
    ["too short", "tereo_sk_" + "aB3_".repeat(10)],
    ["bad characters", "tereo_sk_" + "a+/=".repeat(10) + "abc"],
  ])("rejects %s", (_, v) =>
    expect(secretStrengthProblem(v)).toMatch(/base64url/)
  );

  it.each([
    ["one repeated character", "tereo_sk_" + "a".repeat(43)],
    [
      "a run of six",
      "tereo_sk_" + "aaaaaa" + newClientSecretValue().slice(9, 46),
    ],
    [
      "an ascending sequence",
      "tereo_sk_" + "abcdef" + newClientSecretValue().slice(9, 46),
    ],
    [
      "too few distinct characters",
      "tereo_sk_" + "abcdefghijklmno".repeat(3).slice(0, 43),
    ],
  ])("rejects %s as low entropy", (_, v) =>
    expect(secretStrengthProblem(v)).toMatch(/random/)
  );

  it("never echoes the value", () => {
    const v = "tereo_sk_" + "a".repeat(43);
    expect(secretStrengthProblem(v)).not.toContain("aaaa");
  });
});
