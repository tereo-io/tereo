// @module-tag int
// @module-tag auth

import { getTestPrincipalToken } from "../../../../support/principals.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  encryptTotpSecret,
  generateTotpSecret,
} from "../../../../../utils/totp.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  generateTotpCode,
  getAccessTokenForUser,
  getUiAccessTokenForUser,
} from "../../../../support/auth.js";

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

  // Tokens first: once 2FA is on, a login needs the second factor. It is
  // switched on directly, since enabling it through the API ends the other
  // sessions.
  const userWithTotp = async () => {
    const user = await createTestUser();
    const token = await getUiAccessTokenForUser(user);
    const otherUiToken = await getUiAccessTokenForUser(user);
    const thirdPartyToken = await getAccessTokenForUser(user, testClient);
    const secret = generateTotpSecret();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        totpSecret: encryptTotpSecret(secret),
        totpEnabled: true,
        totpEnabledAt: new Date(),
      },
    });
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    return { user, headers, secret, otherUiToken, thirdPartyToken };
  };

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

  it("ends the other sessions with the disable, keeping this one", async () => {
    const { user, headers, secret, otherUiToken } = await userWithTotp();
    const other = otherUiToken;
    const before = await prisma.refreshToken.count({
      where: { userId: user.id, revokedAt: null },
    });
    expect(before).toBeGreaterThanOrEqual(2);

    const response = await fetch(`${BASE_URL}/v1/account/totp`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ totpCode: generateTotpCode(secret) }),
    });
    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(
      await prisma.refreshToken.count({
        where: { userId: user.id, revokedAt: null },
      })
    ).toBe(1);
    const me = await fetch(`${BASE_URL}/v1/account/me`, {
      headers: { Authorization: `Bearer ${other}` },
    });
    expect(me.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect((await fetch(`${BASE_URL}/v1/account/me`, { headers })).status).toBe(
      HTTP_STATUS.OK
    );
    const revoked = await prisma.auditLogEntry.findFirst({
      where: {
        entityId: user.id,
        metadata: { path: ["action"], equals: "sessions_revoked" },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(revoked).not.toBeNull();
  });
});
