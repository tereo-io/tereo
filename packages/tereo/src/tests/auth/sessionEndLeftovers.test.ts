import { startFakeOidcProvider } from "../support/fakeOidcProvider.js";
import type { FakeOidcProvider } from "../support/fakeOidcProvider.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrincipalToken } from "../support/principals.js";
import { browserLogin } from "../support/browserLogin.js";
import { hashFlowToken } from "../../utils/crypto.js";
import { prisma } from "../../utils/db/prisma.js";
import {
  BASE_URL,
  createTestClient,
  createTestRole,
  createTestUser,
  generateTotpCode,
  generateUniqueId,
  getUiAccessTokenForUser,
  loginToTotpSetup,
  startTotpSetup,
} from "../support/auth.js";

/**
 * What a sign-out everywhere must not leave behind: a 2FA setup begun from
 * the account page, an authorization code not yet exchanged, a provider link
 * begun from the account page. Each is worth a login, or a factor, after the
 * password that started it has been replaced.
 */

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

let client: Awaited<ReturnType<typeof createTestClient>>;
let fake: FakeOidcProvider;
let providerSlug: string;

beforeAll(async () => {
  client = await createTestClient();
  fake = await startFakeOidcProvider();
  const providerAdmin = await getTestPrincipalToken({
    permissions: ["identity-providers.write"],
  });
  providerSlug = `leftover-${generateUniqueId().toLowerCase()}`.slice(0, 40);
  const res = await fetch(`${BASE_URL}/v1/admin/identity-providers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${providerAdmin}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      slug: providerSlug,
      displayName: `Leftover ${generateUniqueId()}`,
      kind: "oidc",
      issuer: fake.issuer,
      clientId: fake.clientId,
      clientSecret: fake.clientSecret,
    }),
  });
  expect(res.status).toBe(201);
});

afterAll(async () => {
  await fake.close();
});

const bearer = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

const changePassword = async (user: TestUser, token: string) => {
  const res = await fetch(`${BASE_URL}/v1/account/password`, {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({
      currentPassword: user.plainPassword,
      newPassword: "An0ther-Long-Passw0rd!",
    }),
  });
  expect(res.status).toBe(200);
};

const adminResetPassword = async (userId: string) => {
  const admin = await getTestPrincipalToken({ permissions: ["users.write"] });
  const res = await fetch(`${BASE_URL}/v1/admin/users/${userId}`, {
    method: "PATCH",
    headers: bearer(admin),
    body: JSON.stringify({ password: "An0ther-Long-Passw0rd!" }),
  });
  expect(res.status).toBe(200);
};

/** Starts 2FA setup from the account page; returns its secret and token. */
const accountSetup = async (token: string) => {
  const res = await fetch(`${BASE_URL}/v1/account/totp/setup`, {
    method: "POST",
    headers: bearer(token),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { secret: string; setupToken: string };
};

const oauthSetupVerify = (setupToken: string, totpCode: string) =>
  fetch(`${BASE_URL}/oauth/totp/setup/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ setup_token: setupToken, totp_code: totpCode }),
  });

const accountSetupVerify = (
  token: string,
  setupToken: string,
  totpCode: string
) =>
  fetch(`${BASE_URL}/v1/account/totp/setup/verify`, {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({ setupToken, totpCode }),
  });

describe("a 2FA setup begun from the account page", () => {
  it("cannot be completed through the login flow's verify", async () => {
    const user = await createTestUser();
    const token = await getUiAccessTokenForUser(user);
    const { secret, setupToken } = await accountSetup(token);

    const res = await oauthSetupVerify(setupToken, generateTotpCode(secret));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_setup_token"
    );
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(stored.totpEnabled).toBe(false);
  });

  it("is ended by an admin password reset", async () => {
    const user = await createTestUser();
    const token = await getUiAccessTokenForUser(user);
    const { setupToken } = await accountSetup(token);

    await adminResetPassword(user.id);

    expect(
      await prisma.totpSetupSession.findUnique({
        where: { tokenHash: hashFlowToken(setupToken) },
      })
    ).toBeNull();
  });

  it("is ended by a password change, even from the browser that began it", async () => {
    const user = await createTestUser();
    const token = await getUiAccessTokenForUser(user);
    const { secret, setupToken } = await accountSetup(token);

    await changePassword(user, token);

    const res = await accountSetupVerify(
      token,
      setupToken,
      generateTotpCode(secret)
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_setup_token"
    );
  });
});

describe("a 2FA setup begun at login", () => {
  it("cannot be completed through the account page's verify", async () => {
    const user = await createTestUser();
    // Signed in to core's UI before 2FA was required of them.
    const token = await getUiAccessTokenForUser(user);
    const role = await createTestRole();
    await prisma.role.update({
      where: { id: role.id },
      data: { requires2fa: true },
    });
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id },
    });
    const login = await loginToTotpSetup(user, client);
    const started = await startTotpSetup(
      { setup_grant: login.setupGrant },
      login.grantCookie
    );
    expect(started.status).toBe(200);
    const { secret, setupToken } = (await started.json()) as {
      secret: string;
      setupToken: string;
    };

    const res = await accountSetupVerify(
      token,
      setupToken,
      generateTotpCode(secret)
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_setup_token"
    );
  });
});

describe("an authorization code not yet exchanged", () => {
  it("is gone after a sign-out everywhere", async () => {
    const user = await createTestUser();
    const { code } = await browserLogin({
      clientId: client.clientId,
      redirectUri: client.redirectUris[0],
      scope: "openid",
      email: user.email,
      password: user.plainPassword,
    });

    await adminResetPassword(user.id);

    expect(
      await prisma.authorizationCode.count({
        where: { userId: user.id, usedAt: null },
      })
    ).toBe(0);
    const exchange = await fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: client.redirectUris[0],
        client_id: client.clientId,
        client_secret: client.plainSecret,
      }),
    });
    expect(exchange.status).toBe(400);
  });

  it("survives under the SSO session the caller keeps", async () => {
    const user = await createTestUser();
    const token = await getUiAccessTokenForUser(user);
    const kept = await prisma.userSession.findFirstOrThrow({
      where: { userId: user.id },
    });
    // One more code that browser was issued, not yet exchanged.
    const pending = await prisma.authorizationCode.create({
      data: {
        codeHash: hashFlowToken(generateUniqueId()),
        clientId: client.id,
        userId: user.id,
        redirectUri: client.redirectUris[0],
        scopes: ["openid"],
        codeChallenge: "x".repeat(43),
        codeChallengeMethod: "S256",
        authTime: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        userSessionId: kept.id,
      },
    });

    await changePassword(user, token);

    expect(
      await prisma.authorizationCode.findUnique({ where: { id: pending.id } })
    ).not.toBeNull();
  });
});

describe("a provider link begun from the account page", () => {
  it("is ended by a sign-out everywhere", async () => {
    const user = await createTestUser();
    const token = await getUiAccessTokenForUser(user);
    const begin = await fetch(`${BASE_URL}/v1/account/identities`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ provider: providerSlug }),
    });
    expect(begin.status).toBe(200);
    expect(
      await prisma.upstreamAuthSession.count({
        where: { userId: user.id, purpose: "link" },
      })
    ).toBe(1);

    await adminResetPassword(user.id);

    expect(
      await prisma.upstreamAuthSession.count({ where: { userId: user.id } })
    ).toBe(0);
  });
});
