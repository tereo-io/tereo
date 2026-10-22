// @module-tag int
// @module-tag auth
// @module-tag race
import { prisma } from "../../../../../utils/db/prisma.js";
import { describe, it, expect } from "vitest";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestUser,
  generateTotpCode,
  getUiAccessTokenForUser,
} from "../../../../support/auth.js";

describe("/v1/account/totp", () => {
  describe("TOTP replay on /account/totp", () => {
    const enable = async () => {
      const user = await createTestUser();
      const token = await getUiAccessTokenForUser(user);
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };
      const setup = (await (
        await fetch(`${BASE_URL}/v1/account/totp/setup`, {
          method: "POST",
          headers,
        })
      ).json()) as { secret: string; setupToken: string };
      const code = generateTotpCode(setup.secret);
      const verify = await fetch(`${BASE_URL}/v1/account/totp/setup/verify`, {
        method: "POST",
        headers,
        body: JSON.stringify({ setupToken: setup.setupToken, totpCode: code }),
      });
      expect(verify.status).toBe(HTTP_STATUS.OK);
      return { user, headers, secret: setup.secret, code };
    };

    it("rejects the code that enabled TOTP when it is used again", async () => {
      const { user, headers, secret, code } = await enable();

      const regenerate = await fetch(
        `${BASE_URL}/v1/account/totp/recovery-codes`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ totpCode: code }),
        }
      );
      expect(regenerate.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(((await regenerate.json()) as { error: string }).error).toBe(
        "invalid_code"
      );

      const disable = (totpCode: string) =>
        fetch(`${BASE_URL}/v1/account/totp`, {
          method: "DELETE",
          headers,
          body: JSON.stringify({ totpCode }),
        });
      expect((await disable(code)).status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
          .totpEnabled
      ).toBe(true);

      expect((await disable(generateTotpCode(secret, 1))).status).toBe(
        HTTP_STATUS.OK
      );
      const stored = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(stored.totpEnabled).toBe(false);
      expect(stored.totpLastWindow).toBeNull();
    });

    it("rejects a code used for one account action on the next", async () => {
      const { headers, secret } = await enable();
      const next = generateTotpCode(secret, 1);

      const regenerate = await fetch(
        `${BASE_URL}/v1/account/totp/recovery-codes`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ totpCode: next }),
        }
      );
      expect(regenerate.status).toBe(HTTP_STATUS.OK);

      const disable = await fetch(`${BASE_URL}/v1/account/totp`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ totpCode: next }),
      });
      expect(disable.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });
});
