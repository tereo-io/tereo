import { handleRefreshToken } from "../../utils/auth.js";
import { describe, it, expect, beforeAll } from "vitest";
import { browserLogin } from "../utils/browserLogin.js";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  getAccessTokenForUser,
} from "./utils/test-helpers.js";

/**
 * Signing out everywhere must also reach the token families being created
 * while it runs: a code obtained just before it, and a refresh in flight.
 */

const SCOPE = "openid offline_access";

let client: Awaited<ReturnType<typeof createTestClient>>;

beforeAll(async () => {
  client = await createTestClient();
});

const signOutOthers = async (bearer: string) => {
  const res = await fetch(`${BASE_URL}/v1/account/sessions`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${bearer}` },
  });
  expect(res.status).toBeLessThan(300);
};

const exchange = (code: string, verifier: string) =>
  fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: client.redirectUris[0],
      client_id: client.clientId,
      code_verifier: verifier,
    }),
  });

const login = (user: { email: string; plainPassword: string }) =>
  browserLogin({
    clientId: client.clientId,
    redirectUri: client.redirectUris[0],
    scope: SCOPE,
    email: user.email,
    password: user.plainPassword,
  });

describe("ending sessions while tokens are being issued", () => {
  it("a code obtained before sign-out-everywhere cannot be exchanged after it", async () => {
    const user = await createTestUser();
    const { code, verifier } = await login(user);
    const other = await getAccessTokenForUser(user, client);

    await signOutOthers(other);

    const res = await exchange(code, verifier);
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_grant"
    );
  });

  it("a refresh in flight during sign-out-everywhere leaves no live token", async () => {
    const user = await createTestUser();
    const { code, verifier } = await login(user);
    const tokens = (await (await exchange(code, verifier)).json()) as {
      refresh_token: string;
    };
    const family = await prisma.authorizationCode.findFirstOrThrow({
      where: { userId: user.id, usedAt: { not: null } },
      select: { id: true },
    });
    const other = await getAccessTokenForUser(user, client);
    const clientRecord = await db.clients.getByClientId(client.clientId);

    // The refresh reads the user's permissions while it runs; the sign-out
    // lands there, between the refresh's start and its new tokens.
    const roles = db.roles;
    (db as { roles: typeof roles }).roles = {
      ...roles,
      getUserPermissions: async (...args) => {
        await signOutOthers(other);
        return roles.getUserPermissions(...args);
      },
    };
    try {
      await expect(
        handleRefreshToken(clientRecord, {
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: tokens.refresh_token,
        })
      ).rejects.toThrow("invalid_grant");
    } finally {
      (db as { roles: typeof roles }).roles = roles;
    }

    expect(
      await prisma.refreshToken.count({
        where: { authCodeId: family.id, revokedAt: null },
      })
    ).toBe(0);
  });
});
