// @module-tag int
// @module-tag auth

import { BASE_URL, HTTP_STATUS } from "../../../../support/auth/constants.js";
import { createUserWithTotp } from "../../../../support/auth/totpSetup.js";
import { getTestPrincipalToken } from "../../../../support/principals.js";
import { createTestClient } from "../../../../support/auth/clients.js";
import { generateTotpCode } from "../../../../support/auth/crypto.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";

interface ErrorResponse {
  error?: string;
  error_description?: string;
  message?: string;
  [key: string]: unknown;
}

let testClient: Awaited<ReturnType<typeof createTestClient>>;

beforeAll(async () => {
  testClient = await createTestClient();
});

describe("POST /v1/account/totp/recovery-codes and DELETE /v1/account/totp", () => {
  const routes = [
    { method: "POST", path: "/v1/account/totp/recovery-codes" },
    { method: "DELETE", path: "/v1/account/totp" },
  ];

  const userWithTotp = () => createUserWithTotp(testClient);

  for (const { method, path } of routes) {
    it(`refuses ${method} ${path} from a third-party client`, async () => {
      const { user, secret, thirdPartyToken } = await userWithTotp();
      const response = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${thirdPartyToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ totpCode: generateTotpCode(secret) }),
      });
      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      // requireCoreUi's refusal, not another 403 such as reauth_required.
      const body = (await response.json()) as ErrorResponse;
      expect(body.error).toBe("forbidden");
      expect(body.error_description).toBe(
        "Changing how you sign in is only possible in core's own UI"
      );
      const stored = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(stored.totpEnabled).toBe(true);
    });

    it(`refuses ${method} ${path} without a recent login with 403 reauth_required`, async () => {
      const { user, secret } = await userWithTotp();
      // Minted directly, so it carries no auth_time.
      const token = await getTestPrincipalToken({
        userId: user.id,
        permissions: [],
      });
      const response = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ totpCode: generateTotpCode(secret) }),
      });
      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(((await response.json()) as ErrorResponse).error).toBe(
        "reauth_required"
      );
    });
  }

  it("regenerates recovery codes from a fresh UI login", async () => {
    const { headers, secret } = await userWithTotp();
    const response = await fetch(`${BASE_URL}/v1/account/totp/recovery-codes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ totpCode: generateTotpCode(secret) }),
    });
    expect(response.status).toBe(HTTP_STATUS.OK);
  });
});
