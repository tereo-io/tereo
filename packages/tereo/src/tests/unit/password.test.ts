import { hashPassword, verifyPassword } from "../../utils/crypto.js";
import { describe, expect, it } from "vitest";

describe("verifyPassword", () => {
  it("accepts the right password and refuses a wrong one", async () => {
    const hash = await hashPassword("Correct-horse-1");
    expect(await verifyPassword(hash, "Correct-horse-1")).toBe(true);
    expect(await verifyPassword(hash, "Wrong-horse-1")).toBe(false);
  });

  it("refuses rather than throws on a malformed stored hash", async () => {
    const [salt] = (await hashPassword("x")).split(":");
    expect(await verifyPassword(`${salt}:abcd`, "x")).toBe(false);
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
  });
});
