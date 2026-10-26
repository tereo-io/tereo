// @module-tag int
// @module-tag auth
import { encryptTotpSecret, generateTotpSecret } from "../../../utils/totp.js";
import { getTestPrincipalToken } from "../../support/principals.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UPSTREAM_COOKIE } from "../../support/upstreamLogin.js";
import { createTestClient } from "../../support/auth/clients.js";
import { createTestUser } from "../../support/auth/users.js";
import { decodeJwt } from "../../support/auth/tokens.js";
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
  DEFAULT_ORGANIZATION_ID,
  SYSTEM_USER_ID,
} from "../../../definitions/index.js";
import {
  generateTotpCode,
  generateUniqueId,
} from "../../support/auth/crypto.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../support/webhooks.js";

const REDIRECT_URI = "http://localhost:3000/callback";
const SCOPE = "openid profile email";

interface Provider {
  id: string;
  slug: string;
  displayName: string;
}

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

let fake: FakeOidcProvider;
let provider: Provider;
let other: Provider;
let client: Awaited<ReturnType<typeof createTestClient>>;
let adminToken: string;

const createProvider = async (): Promise<Provider> => {
  const res = await fetch(`${CORE_URL}/v1/admin/identity-providers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      slug: `sso-${generateUniqueId().toLowerCase()}`.slice(0, 40),
      displayName: `SSO ${generateUniqueId()}`,
      kind: "oidc",
      issuer: fake.issuer,
      clientId: fake.clientId,
      clientSecret: fake.clientSecret,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Provider;
};

/** A fresh domain of `owner`'s, by default one that must sign in through it. */
const ssoOnlyDomain = async (owner: Provider, ssoOnly = true) => {
  const domain = `sso-${generateUniqueId().toLowerCase()}.example`;
  await prisma.identityProviderDomain.create({
    data: {
      providerId: owner.id,
      domain,
      organizationId: DEFAULT_ORGANIZATION_ID,
      ssoOnly,
      createdBy: SYSTEM_USER_ID,
    },
  });
  return domain;
};

const ssoUser = async (owner: Provider = provider) =>
  await createTestUser({
    email: `user-${generateUniqueId().toLowerCase()}@${await ssoOnlyDomain(owner)}`,
  });

let lastIp = 0;
/** A client address of this file's own, so no limiter is shared. */
const freshIp = () => `10.77.0.${++lastIp}`;

/** `/oauth/authorize`, then the password POST, as one browser. */
const submitPassword = async (
  email: string,
  password: string,
  jar: CookieJar = new Map(),
  ip = freshIp()
) => {
  const pkce = newPkce();
  const params = {
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: REDIRECT_URI,
    state: pkce.state,
    scope: SCOPE,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  };
  const authorize = await fetch(
    `${CORE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
    { redirect: "manual", headers: { "X-Forwarded-For": ip } }
  );
  absorbCookies(jar, authorize);
  const res = await fetch(`${CORE_URL}/oauth/authorize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": ip,
      Cookie: cookieHeader(jar),
    },
    body: JSON.stringify({ ...params, email, password }),
  });
  absorbCookies(jar, res);
  return { res, jar, verifier: pkce.verifier, ip };
};

/** The password POST up to the link-required page; returns the grant. */
const toLinkRequired = async (user: TestUser) => {
  const flow = await submitPassword(user.email, user.plainPassword);
  expect(flow.res.status).toBe(200);
  const { redirect_url } = (await flow.res.json()) as { redirect_url: string };
  const page = new URL(redirect_url);
  expect(page.origin + page.pathname).toBe(
    `${env.UI_BASE_URL}/login/link-required`
  );
  const grant = page.searchParams.get("grant")!;
  expect(grant).toBeTruthy();
  return { ...flow, page, grant };
};

const start = async (
  slug: string,
  grant: string,
  jar: CookieJar,
  ip: string
) => {
  const res = await fetch(
    `${CORE_URL}/oauth/upstream/${slug}/start?${new URLSearchParams({ grant })}`,
    {
      redirect: "manual",
      headers: { Cookie: cookieHeader(jar), "X-Forwarded-For": ip },
    }
  );
  absorbCookies(jar, res);
  return res;
};

/** Start, the fake provider, and core's callback; returns the callback. */
const forcedLink = async (
  slug: string,
  grant: string,
  jar: CookieJar,
  ip: string,
  claims: { sub: string; email?: string; email_verified?: boolean },
  beforeCallback?: () => Promise<unknown>
) => {
  const started = await start(slug, grant, jar, ip);
  expect(started.status).toBe(302);
  const providerUrl = new URL(started.headers.get("location") ?? "");
  expect(providerUrl.origin).toBe(fake.issuer);
  fake.nextIdentity({ email_verified: true, ...claims });
  const atProvider = await fetch(providerUrl, { redirect: "manual" });
  expect(atProvider.status).toBe(302);
  await beforeCallback?.();
  const callback = await fetch(atProvider.headers.get("location") ?? "", {
    redirect: "manual",
    headers: { Cookie: cookieHeader(jar), "X-Forwarded-For": ip },
  });
  absorbCookies(jar, callback);
  return callback;
};

const approveConsent = async (jar: CookieJar, location: URL) => {
  expect(location.pathname).toBe("/consent");
  const res = await fetch(`${CORE_URL}/oauth/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify({
      session_token: location.searchParams.get("session"),
      approved: true,
    }),
  });
  expect(res.status).toBe(200);
  const { redirect_url } = (await res.json()) as { redirect_url: string };
  const code = new URL(redirect_url).searchParams.get("code");
  expect(code).toBeTruthy();
  return code!;
};

const exchange = async (code: string, verifier: string) =>
  decodeJwt((await exchangeTokens(code, verifier)).id_token);

const exchangeTokens = async (code: string, verifier: string) => {
  const res = await fetch(`${CORE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: client.clientId,
      code_verifier: verifier,
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id_token: string; refresh_token: string };
};

const refresh = (refreshToken: string) =>
  fetch(`${CORE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.clientId,
    }),
  });

const grantCount = (userId: string) =>
  prisma.identityLinkGrant.count({ where: { userId } });

const passwordHashOf = async (userId: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).passwordHash;

const expectLoginError = (res: Response, error: string, restart = true) => {
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe(`${env.UI_BASE_URL}/login`);
  expect(location.searchParams.get("error")).toBe(error);
  if (restart) {
    expect(location.searchParams.get("client_id")).toBe(client.clientId);
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
  }
};

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({
    permissions: ["identity-providers.write"],
  });
  client = await createTestClient();
  fake = await startFakeOidcProvider();
  provider = await createProvider();
  other = await createProvider();
});

afterAll(async () => {
  await fake.close();
});

describe("the forced link", () => {
  it("links the provider, clears the password and signs in as a provider login", async () => {
    const user = await ssoUser();
    const { jar, grant, ip, verifier } = await toLinkRequired(user);
    const sub = `sub-${randomUUID()}`;

    const callback = await forcedLink(provider.slug, grant, jar, ip, {
      sub,
      email: user.email,
    });
    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get("location") ?? "");
    const claims = await exchange(
      await approveConsent(jar, location),
      verifier
    );
    expect(claims.sub).toBe(user.id);
    expect(claims.amr).toEqual(["fed"]);

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(stored.passwordHash).toBeNull();
    const identity = await prisma.userIdentity.findUniqueOrThrow({
      where: {
        userId_providerId: { userId: user.id, providerId: provider.id },
      },
    });
    expect(identity.subject).toBe(sub);
    expect(
      await prisma.identityLinkGrant.count({ where: { userId: user.id } })
    ).toBe(0);
    const removal = await prisma.auditLogEntry.findFirst({
      where: { entityType: "User", entityId: user.id, action: "UPDATE" },
    });
    expect(removal?.metadata).toMatchObject({
      passwordRemoved: true,
      reason: "sso_only",
    });

    // Single-use: the same grant starts nothing a second time.
    const again = await start(provider.slug, grant, jar, ip);
    expectLoginError(again, "session_expired", false);
  });

  it("refuses a grant without its cookie", async () => {
    const user = await ssoUser();
    const { grant, ip } = await toLinkRequired(user);
    const res = await start(provider.slug, grant, new Map(), ip);
    expectLoginError(res, "session_expired");
  });

  it("refuses a grant taken to a provider that does not own the domain", async () => {
    const user = await ssoUser();
    const { jar, grant, ip } = await toLinkRequired(user);
    const res = await start(other.slug, grant, jar, ip);
    expectLoginError(res, "session_expired");
    expect(res.headers.get("location")).not.toContain(fake.issuer);
  });

  it("refuses a subject linked to someone else, and leaves the grant usable", async () => {
    const holder = await createTestUser();
    const taken = `sub-${randomUUID()}`;
    await prisma.userIdentity.create({
      data: { userId: holder.id, providerId: provider.id, subject: taken },
    });
    const user = await ssoUser();
    const { jar, grant, ip, verifier } = await toLinkRequired(user);

    const refused = await forcedLink(provider.slug, grant, jar, ip, {
      sub: taken,
      email: user.email,
    });
    expectLoginError(refused, "identity_in_use");
    const unchanged = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(unchanged.passwordHash).not.toBeNull();

    const retried = await forcedLink(provider.slug, grant, jar, ip, {
      sub: `sub-${randomUUID()}`,
      email: user.email,
    });
    expect(retried.status).toBe(302);
    const location = new URL(retried.headers.get("location") ?? "");
    const claims = await exchange(
      await approveConsent(jar, location),
      verifier
    );
    expect(claims.sub).toBe(user.id);
    // The upstream cookie of the round trip is spent either way.
    expect(jar.get(UPSTREAM_COOKIE)).toBeUndefined();
  });

  it("refuses a provider account whose verified email is not the user's, keeping the grant", async () => {
    const user = await ssoUser();
    const { jar, grant, ip } = await toLinkRequired(user);

    const refused = await forcedLink(provider.slug, grant, jar, ip, {
      sub: `sub-${randomUUID()}`,
      email: `someone-else-${generateUniqueId().toLowerCase()}@personal.example`,
    });
    expectLoginError(refused, "account_mismatch");
    expect(await passwordHashOf(user.id)).not.toBeNull();
    expect(await grantCount(user.id)).toBe(1);
    expect(
      await prisma.userIdentity.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("refuses a provider account whose email is unverified", async () => {
    const user = await ssoUser();
    const { jar, grant, ip } = await toLinkRequired(user);

    const refused = await forcedLink(provider.slug, grant, jar, ip, {
      sub: `sub-${randomUUID()}`,
      email: user.email,
      email_verified: false,
    });
    expectLoginError(refused, "email_unverified");
    expect(await passwordHashOf(user.id)).not.toBeNull();
    expect(await grantCount(user.id)).toBe(1);
  });

  it("emits auth.user.identity-linked", async () => {
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["auth.user.identity-linked"] }
    );
    const user = await ssoUser();
    const { jar, grant, ip } = await toLinkRequired(user);
    const callback = await forcedLink(provider.slug, grant, jar, ip, {
      sub: `sub-${randomUUID()}`,
      email: user.email,
    });
    expect(callback.status).toBe(302);
    const identity = await prisma.userIdentity.findUniqueOrThrow({
      where: {
        userId_providerId: { userId: user.id, providerId: provider.id },
      },
    });

    await waitFor(
      async () =>
        (await prisma.webhookDelivery.count({
          where: {
            webhookEndpointId: endpoint.id,
            eventType: "auth.user.identity-linked",
            payload: { path: ["entityId"], equals: identity.id },
          },
        })) > 0,
      10000
    );
  });

  it("emits auth.user.password-changed with reason sso_only", async () => {
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["auth.user.password-changed"] }
    );
    const user = await ssoUser();
    const { jar, grant, ip } = await toLinkRequired(user);
    const callback = await forcedLink(provider.slug, grant, jar, ip, {
      sub: `sub-${randomUUID()}`,
      email: user.email,
    });
    expect(callback.status).toBe(302);

    let payload: { data?: Record<string, unknown> } | undefined;
    await waitFor(async () => {
      const delivery = await prisma.webhookDelivery.findFirst({
        where: {
          webhookEndpointId: endpoint.id,
          eventType: "auth.user.password-changed",
          payload: { path: ["entityId"], equals: user.id },
        },
      });
      payload = delivery?.payload as typeof payload;
      return delivery !== null;
    }, 10000);
    expect(payload?.data).toEqual({
      userId: user.id,
      email: user.email,
      reason: "sso_only",
    });
  });

  it("refuses a grant that expired during the round trip, keeping the password", async () => {
    const user = await ssoUser();
    const { jar, grant, ip } = await toLinkRequired(user);
    const refused = await forcedLink(
      provider.slug,
      grant,
      jar,
      ip,
      { sub: `sub-${randomUUID()}`, email: user.email },
      () =>
        prisma.identityLinkGrant.updateMany({
          where: { userId: user.id },
          data: { expiresAt: new Date(Date.now() - 1000) },
        })
    );
    expectLoginError(refused, "session_expired");
    expect(await passwordHashOf(user.id)).not.toBeNull();
    expect(
      await prisma.userIdentity.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("refuses when the domain stops being SSO-only during the round trip", async () => {
    const user = await ssoUser();
    const { jar, grant, ip } = await toLinkRequired(user);
    const refused = await forcedLink(
      provider.slug,
      grant,
      jar,
      ip,
      { sub: `sub-${randomUUID()}`, email: user.email },
      () =>
        prisma.identityProviderDomain.update({
          where: { domain: user.email.split("@")[1] },
          data: { ssoOnly: false },
        })
    );
    expectLoginError(refused, "session_expired");
    expect(await passwordHashOf(user.id)).not.toBeNull();
  });

  it("goes on to TOTP for a user who has it, recording fed and otp", async () => {
    const user = await ssoUser();
    const secret = generateTotpSecret();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        totpSecret: encryptTotpSecret(secret),
        totpEnabled: true,
        totpEnabledAt: new Date(),
      },
    });
    const { jar, grant, ip, verifier } = await toLinkRequired(user);
    const sub = `sub-${randomUUID()}`;
    const callback = await forcedLink(provider.slug, grant, jar, ip, {
      sub,
      email: user.email,
    });
    const twoFactor = new URL(callback.headers.get("location") ?? "");
    expect(twoFactor.pathname).toBe("/login/2fa");

    // Nothing is committed before the second factor.
    expect(await passwordHashOf(user.id)).not.toBeNull();
    expect(
      await prisma.userIdentity.count({ where: { userId: user.id } })
    ).toBe(0);
    expect(await grantCount(user.id)).toBe(1);

    const verify = await fetch(`${CORE_URL}/oauth/totp/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({
        session_token: twoFactor.searchParams.get("session"),
        totp_code: generateTotpCode(secret),
      }),
    });
    absorbCookies(jar, verify);
    expect(verify.status).toBe(200);
    const { redirect_url } = (await verify.json()) as { redirect_url: string };
    const claims = await exchange(
      await approveConsent(jar, new URL(redirect_url)),
      verifier
    );
    expect(claims.amr).toEqual(["fed", "otp"]);
    expect(await passwordHashOf(user.id)).toBeNull();
    expect(await grantCount(user.id)).toBe(0);
    const identity = await prisma.userIdentity.findUniqueOrThrow({
      where: { providerId_subject: { providerId: provider.id, subject: sub } },
    });
    expect(identity.userId).toBe(user.id);
    // One sign-in, written with the code: none for the link itself.
    const logins = await prisma.auditLogEntry.findMany({
      where: { action: "LOGIN", userId: user.id },
    });
    expect(logins).toHaveLength(1);
    expect(logins[0]).toMatchObject({ entityType: "User", entityId: user.id });
    expect(logins[0].metadata).toMatchObject({
      provider: provider.slug,
      auth_methods: ["fed", "otp"],
    });
  });

  it("keeps the password and earlier sessions while the TOTP step is pending", async () => {
    const domain = await ssoOnlyDomain(provider, false);
    const user = await createTestUser({
      email: `user-${generateUniqueId().toLowerCase()}@${domain}`,
    });
    const secret = generateTotpSecret();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        totpSecret: encryptTotpSecret(secret),
        totpEnabled: true,
        totpEnabledAt: new Date(),
      },
    });
    const before = await submitPassword(user.email, user.plainPassword);
    const { redirect_url } = (await before.res.json()) as {
      redirect_url: string;
    };
    const verified = await fetch(`${CORE_URL}/oauth/totp/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(before.jar),
      },
      body: JSON.stringify({
        session_token: new URL(redirect_url).searchParams.get("session"),
        totp_code: generateTotpCode(secret),
      }),
    });
    absorbCookies(before.jar, verified);
    const earlier = await exchangeTokens(
      await approveConsent(
        before.jar,
        new URL(
          ((await verified.json()) as { redirect_url: string }).redirect_url
        )
      ),
      before.verifier
    );

    await prisma.identityProviderDomain.update({
      where: { domain },
      data: { ssoOnly: true },
    });
    const { jar, grant, ip } = await toLinkRequired(user);
    const callback = await forcedLink(provider.slug, grant, jar, ip, {
      sub: `sub-${randomUUID()}`,
      email: user.email,
    });
    expect(new URL(callback.headers.get("location") ?? "").pathname).toBe(
      "/login/2fa"
    );

    expect(await passwordHashOf(user.id)).not.toBeNull();
    expect((await refresh(earlier.refresh_token)).status).toBe(200);
  });

  it("drops the pending link with its grant, and the TOTP step with it", async () => {
    const user = await ssoUser();
    const secret = generateTotpSecret();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        totpSecret: encryptTotpSecret(secret),
        totpEnabled: true,
        totpEnabledAt: new Date(),
      },
    });
    const { jar, grant, ip } = await toLinkRequired(user);
    const callback = await forcedLink(provider.slug, grant, jar, ip, {
      sub: `sub-${randomUUID()}`,
      email: user.email,
    });
    const twoFactor = new URL(callback.headers.get("location") ?? "");
    await prisma.identityLinkGrant.deleteMany({ where: { userId: user.id } });

    const verify = await fetch(`${CORE_URL}/oauth/totp/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({
        session_token: twoFactor.searchParams.get("session"),
        totp_code: generateTotpCode(secret),
      }),
    });
    expect(verify.status).toBe(400);
    expect(((await verify.json()) as { error: string }).error).toBe(
      "invalid_session"
    );
    expect(await passwordHashOf(user.id)).not.toBeNull();
    expect(
      await prisma.userIdentity.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("commits nothing for a user who must first enrol in TOTP", async () => {
    const user = await ssoUser();
    await prisma.systemSetting.update({
      where: { key: "totpPolicy" },
      data: { value: "required" },
    });
    try {
      const { jar, grant, ip } = await toLinkRequired(user);
      const callback = await forcedLink(provider.slug, grant, jar, ip, {
        sub: `sub-${randomUUID()}`,
        email: user.email,
      });
      expect(new URL(callback.headers.get("location") ?? "").pathname).toBe(
        "/login/2fa/setup"
      );
    } finally {
      await prisma.systemSetting.update({
        where: { key: "totpPolicy" },
        data: { value: "optional" },
      });
    }
    expect(await passwordHashOf(user.id)).not.toBeNull();
    expect(
      await prisma.userIdentity.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("ends the user's earlier sessions, and keeps the one it signs in", async () => {
    const domain = await ssoOnlyDomain(provider, false);
    const user = await createTestUser({
      email: `user-${generateUniqueId().toLowerCase()}@${domain}`,
    });
    const before = await submitPassword(user.email, user.plainPassword);
    expect(before.res.status).toBe(200);
    const { redirect_url } = (await before.res.json()) as {
      redirect_url: string;
    };
    const earlier = await exchangeTokens(
      await approveConsent(before.jar, new URL(redirect_url)),
      before.verifier
    );
    expect(earlier.refresh_token).toBeTruthy();

    await prisma.identityProviderDomain.update({
      where: { domain },
      data: { ssoOnly: true },
    });
    const { jar, grant, ip, verifier } = await toLinkRequired(user);
    const callback = await forcedLink(provider.slug, grant, jar, ip, {
      sub: `sub-${randomUUID()}`,
      email: user.email,
    });
    const current = await exchangeTokens(
      await approveConsent(
        jar,
        new URL(callback.headers.get("location") ?? "")
      ),
      verifier
    );

    expect((await refresh(earlier.refresh_token)).status).toBe(400);
    expect((await refresh(current.refresh_token)).status).toBe(200);
  });
});
