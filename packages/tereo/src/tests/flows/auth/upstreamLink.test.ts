// @module-tag int
// @module-tag auth
import { UPSTREAM_COOKIE, upstreamLogin } from "../../support/upstreamLogin.js";
import { getTestPrincipalToken } from "../../support/principals.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { CORE_URL } from "../../support/coreUrl.js";
import { randomUUID } from "node:crypto";
import env from "../../../env.js";
import {
  startFakeOidcProvider,
  type FakeOidcProvider,
} from "../../support/fakeOidcProvider.js";
import {
  absorbCookies,
  cookieHeader,
  newPkce,
  type CookieJar,
} from "../../support/browserLogin.js";
import {
  CORE_SCOPES,
  DEFAULT_ORGANIZATION_ID,
  LOGIN_CLIENT,
} from "../../../definitions/index.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../support/webhooks.js";
import {
  createTestClient,
  createTestUser,
  decodeJwt,
  generateUniqueId,
  getAccessTokenForUser,
} from "../../support/auth.js";

const SCOPE = ["openid profile email", ...CORE_SCOPES.map((s) => s.name)].join(
  " "
);

interface Provider {
  id: string;
  slug: string;
  displayName: string;
}

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

let fake: FakeOidcProvider;
let provider: Provider;
let client: Awaited<ReturnType<typeof createTestClient>>;
let providerAdminToken: string;
let usersAdminToken: string;

const createProvider = async (): Promise<Provider> => {
  const res = await fetch(`${CORE_URL}/v1/admin/identity-providers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${providerAdminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      slug: `link-${generateUniqueId().toLowerCase()}`.slice(0, 40),
      displayName: `Link ${generateUniqueId()}`,
      kind: "oidc",
      issuer: fake.issuer,
      clientId: fake.clientId,
      clientSecret: fake.clientSecret,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Provider;
};

beforeAll(async () => {
  providerAdminToken = await getTestPrincipalToken({
    permissions: ["identity-providers.write"],
  });
  usersAdminToken = await getTestPrincipalToken({
    permissions: ["users.read", "users.write"],
  });
  client = await createTestClient();
  fake = await startFakeOidcProvider();
  provider = await createProvider();
});

afterAll(async () => {
  await fake.close();
});

const UI_REDIRECT_URI = `${env.UI_BASE_URL}/callback`;

const uiAuthorizeParams = (challenge: string, extra = {}) => ({
  response_type: "code",
  client_id: LOGIN_CLIENT.clientId,
  redirect_uri: UI_REDIRECT_URI,
  state: "ui",
  scope: "openid profile email",
  code_challenge: challenge,
  code_challenge_method: "S256",
  ...extra,
});

const exchangeUiCode = async (code: string, verifier: string) => {
  const token = await fetch(`${CORE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: UI_REDIRECT_URI,
      client_id: LOGIN_CLIENT.clientId,
      code_verifier: verifier,
    }),
  });
  expect(token.status).toBe(200);
  return ((await token.json()) as { access_token: string }).access_token;
};

/** A password login to core's own UI client; the jar keeps its SSO cookie. */
const freshToken = async (user: TestUser, jar: CookieJar = new Map()) => {
  const { verifier, challenge } = newPkce();
  const params = uiAuthorizeParams(challenge);
  const start = await fetch(
    `${CORE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
    { redirect: "manual", headers: { Cookie: cookieHeader(jar) } }
  );
  absorbCookies(jar, start);
  const submit = await fetch(`${CORE_URL}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify({
      ...params,
      email: user.email,
      password: user.plainPassword,
    }),
  });
  absorbCookies(jar, submit);
  expect(submit.status).toBe(200);
  let { redirect_url } = (await submit.json()) as { redirect_url: string };
  if (new URL(redirect_url).pathname === "/consent") {
    const consent = await fetch(`${CORE_URL}/oauth/consent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({
        session_token: new URL(redirect_url).searchParams.get("session"),
        approved: true,
      }),
    });
    absorbCookies(jar, consent);
    expect(consent.status).toBe(200);
    ({ redirect_url } = (await consent.json()) as { redirect_url: string });
  }
  const code = new URL(redirect_url).searchParams.get("code");
  expect(code).toBeTruthy();
  return await exchangeUiCode(code!, verifier);
};

/** A fresh login, but delegated: a third-party client granted core:account. */
const thirdPartyToken = (user: TestUser) =>
  getAccessTokenForUser(user, client, SCOPE);

/**
 * A real UI token whose `auth_time` is 11 minutes old: the SSO session's
 * auth_time is back-dated, and a `prompt=none` authorize copies it into the
 * code the token is exchanged from.
 */
const staleToken = async (user: TestUser) => {
  const jar: CookieJar = new Map();
  await freshToken(user, jar);
  await prisma.userSession.updateMany({
    where: { userId: user.id },
    data: { authTime: new Date(Date.now() - 11 * 60 * 1000) },
  });

  const { verifier, challenge } = newPkce();
  const authorize = await fetch(
    `${CORE_URL}/oauth/authorize?${new URLSearchParams(
      uiAuthorizeParams(challenge, { prompt: "none" })
    )}`,
    { redirect: "manual", headers: { Cookie: cookieHeader(jar) } }
  );
  expect(authorize.status).toBe(302);
  const code = new URL(
    authorize.headers.get("location") ?? ""
  ).searchParams.get("code");
  expect(code).toBeTruthy();

  const accessToken = await exchangeUiCode(code!, verifier);
  // The refusal below must come from the age, not a missing claim.
  const { auth_time } = decodeJwt(accessToken);
  expect(auth_time).toBeLessThan(Date.now() / 1000 - 600);
  return accessToken;
};

const account = (token: string, method: string, path: string, body?: unknown) =>
  fetch(`${CORE_URL}/v1/account${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const adminUsers = (method: string, path: string, body?: unknown) =>
  fetch(`${CORE_URL}/v1/admin/users${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${usersAdminToken}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/**
 * POST /v1/account/identities, the provider round trip, and core's callback.
 * Returns the callback's response.
 */
const linkFlow = async (
  token: string,
  target: Provider,
  claims: { sub: string; email?: string }
) => {
  const start = await account(token, "POST", "/identities", {
    provider: target.slug,
  });
  expect(start.status).toBe(200);
  const jar: CookieJar = new Map();
  absorbCookies(jar, start);
  expect(jar.get(UPSTREAM_COOKIE)).toBeTruthy();
  const { redirect_url } = (await start.json()) as { redirect_url: string };
  const providerUrl = new URL(redirect_url);
  expect(providerUrl.origin).toBe(fake.issuer);

  fake.nextIdentity(claims);
  const atProvider = await fetch(providerUrl, { redirect: "manual" });
  expect(atProvider.status).toBe(302);
  const callbackUrl = new URL(atProvider.headers.get("location") ?? "");
  const callback = await fetch(callbackUrl, {
    redirect: "manual",
    headers: { Cookie: cookieHeader(jar) },
  });
  return callback;
};

const expectAccountRedirect = (
  res: Response,
  params: { linked?: string; error?: string }
) => {
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe(
    `${env.UI_BASE_URL}/account`
  );
  expect(location.searchParams.get("linked")).toBe(params.linked ?? null);
  expect(location.searchParams.get("error")).toBe(params.error ?? null);
};

const subject = () => `sub-${randomUUID()}`;

describe("linking from the account page", () => {
  it("links the identity, withdraws its invite, and lands on /account?linked=", async () => {
    const user = await createTestUser();
    await prisma.identityInvite.create({
      data: {
        userId: user.id,
        providerId: provider.id,
        createdBy: user.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const token = await freshToken(user);
    const sub = subject();

    const callback = await linkFlow(token, provider, {
      sub,
      email: "someone-else@elsewhere.test",
    });
    expectAccountRedirect(callback, { linked: provider.slug });

    const identity = await prisma.userIdentity.findUnique({
      where: { providerId_subject: { providerId: provider.id, subject: sub } },
    });
    expect(identity?.userId).toBe(user.id);
    expect(identity?.email).toBe("someone-else@elsewhere.test");
    expect(
      await prisma.identityInvite.count({ where: { userId: user.id } })
    ).toBe(0);

    const list = await account(token, "GET", "/identities");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([
      {
        id: identity!.id,
        provider: { slug: provider.slug, displayName: provider.displayName },
        email: "someone-else@elsewhere.test",
        createdAt: identity!.createdAt.toISOString(),
        lastLoginAt: null,
      },
    ]);
  });

  it("refuses a login older than 10 minutes with 403 reauth_required", async () => {
    const user = await createTestUser();
    const token = await staleToken(user);
    const res = await account(token, "POST", "/identities", {
      provider: provider.slug,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "reauth_required"
    );
  });

  it("makes a provider login on an old session there sign in again before linking", async () => {
    const user = await createTestUser();
    const sub = subject();
    await prisma.userIdentity.create({
      data: { userId: user.id, providerId: provider.id, subject: sub },
    });
    const second = await createProvider();
    const providerToken = async (
      authTime: number,
      maxAge?: number
    ): Promise<string> => {
      const { params, verifier, location } = await upstreamLogin({
        provider: fake,
        slug: provider.slug,
        clientId: LOGIN_CLIENT.clientId,
        redirectUri: UI_REDIRECT_URI,
        scope: "openid profile email",
        claims: { sub, email: user.email, auth_time: authTime },
        maxAge,
      });
      expect(location.origin + location.pathname).toBe(UI_REDIRECT_URI);
      expect(location.searchParams.get("state")).toBe(params.state);
      return await exchangeUiCode(location.searchParams.get("code")!, verifier);
    };
    const now = Math.floor(Date.now() / 1000);

    const silent = await providerToken(now - 3600);
    const refused = await account(silent, "POST", "/identities", {
      provider: second.slug,
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "reauth_required"
    );

    const again = await providerToken(now, 0);
    expect(fake.lastAuthorizeQuery()?.get("prompt")).toBe("login");
    const started = await account(again, "POST", "/identities", {
      provider: second.slug,
    });
    expect(started.status).toBe(200);
  });

  it("refuses a token that carries no auth_time", async () => {
    const token = await getTestPrincipalToken({ permissions: [] });
    const res = await account(token, "POST", "/identities", {
      provider: provider.slug,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "reauth_required"
    );
  });

  it("answers 404 for an unknown or inactive provider", async () => {
    const user = await createTestUser();
    const token = await freshToken(user);
    const unknown = await account(token, "POST", "/identities", {
      provider: "no-such-provider",
    });
    expect(unknown.status).toBe(404);

    const inactive = await createProvider();
    await prisma.identityProvider.update({
      where: { id: inactive.id },
      data: { isActive: false },
    });
    const res = await account(token, "POST", "/identities", {
      provider: inactive.slug,
    });
    expect(res.status).toBe(404);
  });

  it("answers 502 upstream_failed when the provider cannot be reached", async () => {
    const user = await createTestUser();
    const token = await freshToken(user);
    const unreachable = await createProvider();
    await prisma.identityProvider.update({
      where: { id: unreachable.id },
      data: { issuer: "http://127.0.0.1:1" },
    });
    const res = await account(token, "POST", "/identities", {
      provider: unreachable.slug,
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe(
      "upstream_failed"
    );
  });

  it("refuses a provider other than an SSO-only domain's, at the start and at the callback", async () => {
    const domain = `sso-${generateUniqueId().toLowerCase()}.test`;
    const user = await createTestUser({ email: `someone@${domain}` });
    const token = await freshToken(user);
    const owner = await createProvider();
    const row = await prisma.identityProviderDomain.create({
      data: {
        providerId: owner.id,
        domain,
        organizationId: DEFAULT_ORGANIZATION_ID,
        ssoOnly: false,
        createdBy: user.id,
      },
    });

    const start = await account(token, "POST", "/identities", {
      provider: provider.slug,
    });
    expect(start.status).toBe(200);
    const jar: CookieJar = new Map();
    absorbCookies(jar, start);
    const { redirect_url } = (await start.json()) as { redirect_url: string };
    await prisma.identityProviderDomain.update({
      where: { id: row.id },
      data: { ssoOnly: true },
    });
    fake.nextIdentity({ sub: subject() });
    const atProvider = await fetch(redirect_url, { redirect: "manual" });
    const callback = await fetch(atProvider.headers.get("location") ?? "", {
      redirect: "manual",
      headers: { Cookie: cookieHeader(jar) },
    });
    expectAccountRedirect(callback, { error: "sso_required" });
    expect(
      await prisma.userIdentity.count({ where: { userId: user.id } })
    ).toBe(0);

    const again = await account(token, "POST", "/identities", {
      provider: provider.slug,
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe(
      "sso_required"
    );
  });

  it("refuses a subject linked to another user with identity_in_use", async () => {
    const other = await createTestUser();
    const sub = subject();
    await prisma.userIdentity.create({
      data: { userId: other.id, providerId: provider.id, subject: sub },
    });
    const user = await createTestUser();
    const callback = await linkFlow(await freshToken(user), provider, { sub });
    expectAccountRedirect(callback, { error: "identity_in_use" });
    expect(
      await prisma.userIdentity.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("refuses a second identity at the same provider with already_linked", async () => {
    const user = await createTestUser();
    await prisma.userIdentity.create({
      data: { userId: user.id, providerId: provider.id, subject: subject() },
    });
    const callback = await linkFlow(await freshToken(user), provider, {
      sub: subject(),
    });
    expectAccountRedirect(callback, { error: "already_linked" });
  });

  it("sends a provider's refusal back to /account, not /login", async () => {
    const user = await createTestUser();
    const start = await account(await freshToken(user), "POST", "/identities", {
      provider: provider.slug,
    });
    const jar: CookieJar = new Map();
    absorbCookies(jar, start);
    const { redirect_url } = (await start.json()) as { redirect_url: string };
    fake.tamper({ error: "access_denied" });
    const atProvider = await fetch(redirect_url, { redirect: "manual" });
    const callback = await fetch(atProvider.headers.get("location") ?? "", {
      redirect: "manual",
      headers: { Cookie: cookieHeader(jar) },
    });
    expectAccountRedirect(callback, { error: "upstream_cancelled" });
  });
});

describe("unlinking", () => {
  const passwordless = async () => {
    const user = await createTestUser();
    const token = await freshToken(user);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: null },
    });
    return { user, token };
  };

  it("unlinks one of the user's identities", async () => {
    const user = await createTestUser();
    const identity = await prisma.userIdentity.create({
      data: { userId: user.id, providerId: provider.id, subject: subject() },
    });
    const res = await account(
      await freshToken(user),
      "DELETE",
      `/identities/${identity.id}`
    );
    expect(res.status).toBe(204);
    expect(
      await prisma.userIdentity.findUnique({ where: { id: identity.id } })
    ).toBeNull();
  });

  it("requires a recent login", async () => {
    const user = await createTestUser();
    const identity = await prisma.userIdentity.create({
      data: { userId: user.id, providerId: provider.id, subject: subject() },
    });
    const res = await account(
      await staleToken(user),
      "DELETE",
      `/identities/${identity.id}`
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "reauth_required"
    );
  });

  it("answers 404 for another user's identity", async () => {
    const other = await createTestUser();
    const identity = await prisma.userIdentity.create({
      data: { userId: other.id, providerId: provider.id, subject: subject() },
    });
    const user = await createTestUser();
    const res = await account(
      await freshToken(user),
      "DELETE",
      `/identities/${identity.id}`
    );
    expect(res.status).toBe(404);
  });

  it("refuses the only sign-in method of a password-less user with 409 last_sign_in_method", async () => {
    const { user, token } = await passwordless();
    const identity = await prisma.userIdentity.create({
      data: { userId: user.id, providerId: provider.id, subject: subject() },
    });
    const res = await account(token, "DELETE", `/identities/${identity.id}`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "last_sign_in_method"
    );
  });

  it("lets a password-less user unlink one of two identities", async () => {
    const { user, token } = await passwordless();
    const second = await createProvider();
    const identity = await prisma.userIdentity.create({
      data: { userId: user.id, providerId: provider.id, subject: subject() },
    });
    await prisma.userIdentity.create({
      data: { userId: user.id, providerId: second.id, subject: subject() },
    });
    const res = await account(token, "DELETE", `/identities/${identity.id}`);
    expect(res.status).toBe(204);
  });

  it("counts no identity at a deactivated provider as another way in", async () => {
    const { user, token } = await passwordless();
    const second = await createProvider();
    const identity = await prisma.userIdentity.create({
      data: { userId: user.id, providerId: provider.id, subject: subject() },
    });
    await prisma.userIdentity.create({
      data: { userId: user.id, providerId: second.id, subject: subject() },
    });
    await prisma.identityProvider.update({
      where: { id: second.id },
      data: { isActive: false },
    });
    const res = await account(token, "DELETE", `/identities/${identity.id}`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "last_sign_in_method"
    );
  });

  it("refuses with 409 sso_required under an SSO-only domain for that provider", async () => {
    const domain = `sso-${generateUniqueId().toLowerCase()}.test`;
    const user = await createTestUser({ email: `someone@${domain}` });
    // Signed in before the domain turns SSO-only, which then refuses passwords.
    const token = await freshToken(user);
    await prisma.identityProviderDomain.create({
      data: {
        providerId: provider.id,
        domain,
        organizationId: DEFAULT_ORGANIZATION_ID,
        ssoOnly: true,
        createdBy: user.id,
      },
    });
    const identity = await prisma.userIdentity.create({
      data: { userId: user.id, providerId: provider.id, subject: subject() },
    });
    const res = await account(token, "DELETE", `/identities/${identity.id}`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "sso_required"
    );
  });

  it("lets an admin unlink, auditing it and emitting auth.user.identity-unlinked", async () => {
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["auth.user.identity-unlinked"] }
    );
    const user = await createTestUser();
    const identity = await prisma.userIdentity.create({
      data: { userId: user.id, providerId: provider.id, subject: subject() },
    });

    const res = await adminUsers(
      "DELETE",
      `/${user.id}/identities/${identity.id}`
    );
    expect(res.status).toBe(204);
    expect(
      await prisma.userIdentity.findUnique({ where: { id: identity.id } })
    ).toBeNull();

    const audit = await prisma.auditLogEntry.findFirst({
      where: { entityType: "UserIdentity", entityId: identity.id },
    });
    expect(audit?.action).toBe("DELETE");

    await waitFor(
      async () =>
        (await prisma.webhookDelivery.count({
          where: {
            webhookEndpointId: endpoint.id,
            eventType: "auth.user.identity-unlinked",
            payload: { path: ["entityId"], equals: identity.id },
          },
        })) > 0,
      10_000
    );
  });

  it("refuses an admin unlink of a user holding permissions the admin does not", async () => {
    const user = await createTestUser();
    // The target holds roles.write, which the users admin does not.
    await getTestPrincipalToken({
      userId: user.id,
      permissions: ["roles.write"],
    });
    const identity = await prisma.userIdentity.create({
      data: { userId: user.id, providerId: provider.id, subject: subject() },
    });

    const res = await adminUsers(
      "DELETE",
      `/${user.id}/identities/${identity.id}`
    );
    expect(res.status).toBe(403);
    expect(
      await prisma.userIdentity.findUnique({ where: { id: identity.id } })
    ).not.toBeNull();
  });

  it("applies the same refusals to an admin unlink", async () => {
    const { user } = await passwordless();
    const identity = await prisma.userIdentity.create({
      data: { userId: user.id, providerId: provider.id, subject: subject() },
    });
    const res = await adminUsers(
      "DELETE",
      `/${user.id}/identities/${identity.id}`
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "last_sign_in_method"
    );
  });
});

describe("only core's UI changes sign-in methods", () => {
  const expectUiOnly = async (res: Response) => {
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("forbidden");
  };

  it("refuses a third-party client's fresh core:account token on link and unlink", async () => {
    const user = await createTestUser();
    const identity = await prisma.userIdentity.create({
      data: { userId: user.id, providerId: provider.id, subject: subject() },
    });
    const token = await thirdPartyToken(user);
    const { auth_time } = decodeJwt(token);
    expect(auth_time).toBeGreaterThan(Date.now() / 1000 - 600);

    await expectUiOnly(
      await account(token, "POST", "/identities", { provider: provider.slug })
    );
    await expectUiOnly(
      await account(token, "DELETE", `/identities/${identity.id}`)
    );
    expect(
      await prisma.upstreamAuthSession.count({ where: { userId: user.id } })
    ).toBe(0);
    expect(
      await prisma.userIdentity.findUnique({ where: { id: identity.id } })
    ).not.toBeNull();

    const list = await account(token, "GET", "/identities");
    expect(list.status).toBe(200);
  });
});
