import { randomBytes, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hashPassword,
  needsRehash,
  verifyPassword,
  RECOVERY_CODE_PARAMS,
} from "../../utils/password.js";

/** A hash as stored before the self-describing format. */
const legacyHash = (password: string) => {
  const salt = randomBytes(32);
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `${salt.toString("hex")}:${key.toString("hex")}`;
};

describe("verifyPassword", () => {
  it("accepts the right password and refuses a wrong one", async () => {
    const hash = await hashPassword("Correct-horse-1");
    expect(await verifyPassword(hash, "Correct-horse-1")).toBe(true);
    expect(await verifyPassword(hash, "Wrong-horse-1")).toBe(false);
  });

  it("stores N=2^14, r=8, p=5 in the hash", async () => {
    const hash = await hashPassword("x");
    expect(hash).toMatch(/^scrypt\$16384\$8\$5\$[0-9a-f]{64}\$[0-9a-f]{128}$/);
    expect(needsRehash(hash)).toBe(false);
  });

  it("verifies a legacy salt:key hash and marks it for rehashing", async () => {
    const hash = legacyHash("Correct-horse-1");
    expect(await verifyPassword(hash, "Correct-horse-1")).toBe(true);
    expect(await verifyPassword(hash, "Wrong-horse-1")).toBe(false);
    expect(needsRehash(hash)).toBe(true);
  });

  it("verifies at the parameters the hash names", async () => {
    const hash = await hashPassword("ABCD2345EFGH", RECOVERY_CODE_PARAMS);
    expect(hash.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(
      await verifyPassword(hash, "ABCD2345EFGH", RECOVERY_CODE_PARAMS)
    ).toBe(true);
    expect(needsRehash(hash)).toBe(true);
    expect(needsRehash(hash, RECOVERY_CODE_PARAMS)).toBe(false);
  });

  it("refuses rather than throws on a malformed stored hash", async () => {
    const [, , , , salt] = (await hashPassword("x")).split("$");
    expect(await verifyPassword(`${salt}:abcd`, "x")).toBe(false);
    expect(await verifyPassword(`scrypt$16384$8$5$${salt}$zz`, "x")).toBe(
      false
    );
    expect(await verifyPassword(`scrypt$1000$8$5$${salt}$abcd`, "x")).toBe(
      false
    );
    expect(await verifyPassword(`scrypt$16384$8$99$${salt}$abcd`, "x")).toBe(
      false
    );
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
    expect(needsRehash("not-a-hash")).toBe(true);
  });
});
