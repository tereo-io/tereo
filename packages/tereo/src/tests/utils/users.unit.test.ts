// @module-tag unit
// @module-tag auth
import { describe, expect, it } from "vitest";
import {
  isUsableAccount,
  remainingSeconds,
  usableAccountWhere,
} from "../../utils/users.js";

const now = new Date("2026-11-06T12:00:00.000Z");
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

describe("isUsableAccount", () => {
  it.each([
    ["active, no expiry", true, null, true],
    ["active, expires later", true, at(1), true],
    ["active, expires now", true, at(0), false],
    ["active, expired", true, at(-1), false],
    ["inactive, no expiry", false, null, false],
    ["inactive, expires later", false, at(60_000), false],
  ])("%s", (_, isActive, expiresAt, usable) => {
    expect(isUsableAccount({ isActive, expiresAt }, now)).toBe(usable);
  });
});

describe("usableAccountWhere", () => {
  it("filters on isActive and an expiry after now", () => {
    expect(usableAccountWhere(now)).toEqual({
      isActive: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    });
  });
});

describe("remainingSeconds", () => {
  it.each([
    ["no expiry", null, null],
    ["whole seconds, rounded down", at(120_999), 120],
    ["under a second", at(500), 0],
    ["past expiry", at(-5_000), 0],
  ])("%s", (_, expiresAt, seconds) => {
    expect(remainingSeconds({ expiresAt }, now)).toBe(seconds);
  });
});
