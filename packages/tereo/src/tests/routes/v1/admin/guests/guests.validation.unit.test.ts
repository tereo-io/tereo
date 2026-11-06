// @module-tag unit
// @module-tag auth
import { UpdateGuestSchema } from "../../../../../routes/v1/admin/guests/guest/schemas.js";
import { InviteGuestSchema } from "../../../../../routes/v1/admin/guests/schemas.js";
import { describe, expect, it } from "vitest";
import env from "../../../../../env.js";

const DAY = 86_400;
const link = { type: "password_setup_link" } as const;
const valid = {
  email: "jane@example.com",
  expiresIn: DAY,
  initialAccess: link,
};

describe("POST /v1/admin/guests", () => {
  describe("InviteGuestSchema", () => {
    it.each([
      [
        "neither expiresAt nor expiresIn",
        { expiresIn: undefined },
        "expiresAt",
      ],
      [
        "both expiresAt and expiresIn",
        { expiresAt: new Date(Date.now() + DAY * 1000).toISOString() },
        "expiresAt",
      ],
      [
        "expiresIn above GUEST_MAX_TTL_SECONDS",
        { expiresIn: env.GUEST_MAX_TTL_SECONDS + 1 },
        "expiresIn",
      ],
      [
        "expiresAt beyond GUEST_MAX_TTL_SECONDS",
        {
          expiresIn: undefined,
          expiresAt: new Date(
            Date.now() + (env.GUEST_MAX_TTL_SECONDS + 60) * 1000
          ).toISOString(),
        },
        "expiresAt",
      ],
      [
        "expiresAt in the past",
        {
          expiresIn: undefined,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        },
        "expiresAt",
      ],
      [
        "a password breaking the password rules",
        { initialAccess: { type: "password", password: "short" } },
        "initialAccess",
      ],
      [
        "an unknown initial access type",
        { initialAccess: { type: "magic" } },
        "initialAccess",
      ],
    ])("rejects %s", (_label, override, field) => {
      const result = InviteGuestSchema.safeParse({ ...valid, ...override });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path[0]).toBe(field);
    });

    it("accepts an email with uppercase and surrounding spaces, normalized", () => {
      const result = InviteGuestSchema.parse({
        ...valid,
        email: "  Jane.Doe@Example.COM ",
      });
      expect(result.email).toBe("jane.doe@example.com");
    });

    it("turns expiresIn into expiresAt", () => {
      const before = Date.now();
      const result = InviteGuestSchema.parse(valid);
      expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + DAY * 1000
      );
      expect(result).not.toHaveProperty("expiresIn");
    });

    it("defaults mustChange to true and notify to false", () => {
      const password = InviteGuestSchema.parse({
        ...valid,
        initialAccess: { type: "password", password: "ValidPassword123!" },
      });
      expect(password.initialAccess).toMatchObject({ mustChange: true });
      expect(InviteGuestSchema.parse(valid).initialAccess).toEqual({
        type: "password_setup_link",
        notify: false,
      });
    });
  });
});

describe("PATCH /v1/admin/guests/:id", () => {
  describe("UpdateGuestSchema", () => {
    it("accepts an expiry in the past", () => {
      expect(
        UpdateGuestSchema.safeParse({
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }).success
      ).toBe(true);
    });

    it.each([
      ["no expiresAt", {}],
      [
        "an expiry beyond GUEST_MAX_TTL_SECONDS",
        {
          expiresAt: new Date(
            Date.now() + (env.GUEST_MAX_TTL_SECONDS + 60) * 1000
          ).toISOString(),
        },
      ],
    ])("rejects %s", (_label, body) => {
      expect(UpdateGuestSchema.safeParse(body).success).toBe(false);
    });
  });
});
