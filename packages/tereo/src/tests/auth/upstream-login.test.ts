import { encryptTotpSecret, generateTotpSecret } from "../../utils/totp.js";
import { absorbCookies, cookieHeader } from "../utils/browserLogin.js";
import { startFakeOidcProvider } from "../utils/fakeOidcProvider.js";
import type { FakeOidcProvider } from "../utils/fakeOidcProvider.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrincipalToken } from "../utils/principals.js";
import type { CookieJar } from "../utils/browserLogin.js";
import { prisma } from "../../utils/db/prisma.js";
import { CORE_URL } from "../utils/coreUrl.js";
import { randomUUID } from "node:crypto";
import env from "../../env.js";
import {
  UPSTREAM_COOKIE,
  upstreamCallback,
  upstreamLogin,
  upstreamToCallback,
} from "../utils/upstreamLogin.js";
import {
  createTestClient,
  createTestRole,
  createTestUser,
  decodeJwt,
  generateTotpCode,
  generateUniqueId,
} from "./utils/test-helpers.js";

const REDIRECT_URI = "http://localhost:3000/callback";
const SCOPE = "openid profile email";
const ACR_MFA = "urn:auth-service:mfa";

let adminToken: string;
let client: Awaited<ReturnType<typeof createTestClient>>;

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({
    permissions: ["identity-providers.write"],
  });
  client = await createTestClient();
});

interface Provider {
  id: string;
  slug: string;
  displayName: string;
}

const loginEntries = (userId: string) =>
  prisma.auditLogEntry.findMany({ where: { action: "LOGIN", userId } });

const admin = (method: string, path: string, body?: unknown) =>
  fetch(`${CORE_URL}/v1/admin/identity-providers${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const createProvider = async (
  fake: FakeOidcProvider,
  overrides: Record<string, unknown> = {}
): Promise<Provider> => {
  const res = await admin("POST", "", {
    slug: `up-${generateUniqueId().toLowerCase()}`.slice(0, 40),
    displayName: `Upstream ${generateUniqueId()}`,
    kind: "oidc",
    issuer: fake.issuer,
    clientId: fake.clientId,
    clientSecret: fake.clientSecret,
    ...overrides,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Provider;
};

const deactivate = async (provider: Provider) => {
  expect((await admin("POST", `/${provider.id}/deactivate`)).status).toBe(200);
};

/** A user linked to `provider` under a fresh subject. */
const linkedUser = async (provider: Provider) => {
  const user = await createTestUser();
  const subject = `sub-${randomUUID()}`;
  await prisma.userIdentity.create({
    data: { userId: user.id, providerId: provider.id, subject },
  });
  return { user, claims: { sub: subject, email: user.email } };
};

const enableTotp = async (userId: string) => {
  const secret = generateTotpSecret();
  await prisma.user.update({
    where: { id: userId },
    data: {
      totpSecret: encryptTotpSecret(secret),
      totpEnabled: true,
      totpEnabledAt: new Date(),
    },
  });
  return secret;
};

const withTotpPolicy = async (
  policy: "required" | "disabled",
  run: () => Promise<void>
) => {
  await prisma.systemSetting.update({
    where: { key: "totpPolicy" },
    data: { value: policy },
  });
  try {
    await run();
  } finally {
    await prisma.systemSetting.update({
      where: { key: "totpPolicy" },
      data: { value: "optional" },
    });
  }
};

/** Runs `run` while `userId` holds a role that requires 2FA. */
const withRequires2faRole = async (
  userId: string,
  run: () => Promise<void>
) => {
  const role = await createTestRole();
  await prisma.role.update({
    where: { id: role.id },
    data: { requires2fa: true },
  });
  await prisma.userRole.create({ data: { userId, roleId: role.id } });
  try {
    await run();
  } finally {
    await prisma.userRole.deleteMany({ where: { userId, roleId: role.id } });
    await prisma.role.update({
      where: { id: role.id },
      data: { requires2fa: false },
    });
  }
};

/** Completes the 2FA page `location` points at; returns where it leads. */
const verifyTotp = async (jar: CookieJar, location: URL, secret: string) => {
  expect(location.pathname).toBe("/login/2fa");
  const verify = await fetch(`${CORE_URL}/oauth/totp/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader(jar),
    },
    body: JSON.stringify({
      session_token: location.searchParams.get("session"),
      totp_code: generateTotpCode(secret),
    }),
  });
  absorbCookies(jar, verify);
  expect(verify.status).toBe(200);
  const { redirect_url } = (await verify.json()) as { redirect_url: string };
  return new URL(redirect_url);
};

const loginFlow = (
  fake: FakeOidcProvider,
  provider: Provider,
  extra: {
    claims?: { sub: string; auth_time?: number };
    acrValues?: string;
    maxAge?: number;
    prompt?: string;
    ip?: string;
  } = {}
) =>
  upstreamLogin({
    provider: fake,
    slug: provider.slug,
    clientId: client.clientId,
    redirectUri: REDIRECT_URI,
    scope: SCOPE,
    ...extra,
  });

/** Approves the consent page `location` points at; returns the code. */
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
  absorbCookies(jar, res);
  expect(res.status).toBe(200);
  const { redirect_url } = (await res.json()) as { redirect_url: string };
  const issued = new URL(redirect_url);
  expect(issued.origin + issued.pathname).toBe(REDIRECT_URI);
  const code = issued.searchParams.get("code");
  expect(code).toBeTruthy();
  return code!;
};

const exchange = async (code: string, verifier: string) => {
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
  const { id_token } = (await res.json()) as { id_token: string };
  return decodeJwt(id_token);
};

/**
 * A failed callback: back to the UI's login page with `error`, never to the
 * client's redirect URI, the upstream cookie cleared. `restart` says whether
 * the authorize request came back with it.
 */
const expectLoginFailure = (res: Response, error: string, restart: boolean) => {
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe(`${env.UI_BASE_URL}/login`);
  expect(location.toString()).not.toContain("localhost:3000/callback?");
  expect(location.searchParams.get("error")).toBe(error);
  if (restart) {
    expect(location.searchParams.get("client_id")).toBe(client.clientId);
    expect(location.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
  } else {
    expect(location.searchParams.get("client_id")).toBeNull();
  }
  const cleared = res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${UPSTREAM_COOKIE}=`));
  expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/i);
};

describe("GET /oauth/upstream/providers", () => {
  let fake: FakeOidcProvider;

  beforeAll(async () => {
    fake = await startFakeOidcProvider();
  });

  afterAll(async () => {
    await fake.close();
  });

  it("lists active providers by display name and hides deactivated ones", async () => {
    const zed = await createProvider(fake, { displayName: "Zed Upstream" });
    const abe = await createProvider(fake, { displayName: "Abe Upstream" });
    const gone = await createProvider(fake);
    await deactivate(gone);

    const res = await fetch(`${CORE_URL}/oauth/upstream/providers`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as { slug: string; displayName: string }[];
    expect(Object.keys(list[0]).sort()).toEqual(["displayName", "slug"]);
    const slugs = list.map((p) => p.slug);
    expect(slugs).not.toContain(gone.slug);
    expect(slugs.indexOf(abe.slug)).toBeLessThan(slugs.indexOf(zed.slug));
    expect(list).toContainEqual({
      slug: abe.slug,
      displayName: "Abe Upstream",
    });
  });
});

describe("sign-in through a provider", () => {
  let fake: FakeOidcProvider;
  let provider: Provider;

  beforeAll(async () => {
    fake = await startFakeOidcProvider();
    provider = await createProvider(fake);
  });

  afterAll(async () => {
    await fake.close();
  });

  it("sets the upstream cookie, scoped and Lax, and sends the browser to the provider", async () => {
    const authorize = await fetch(
      `${CORE_URL}/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: client.clientId,
        redirect_uri: REDIRECT_URI,
        state: "s1",
        scope: SCOPE,
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
      })}`,
      { redirect: "manual" }
    );
    const jar: CookieJar = new Map();
    absorbCookies(jar, authorize);
    const start = await fetch(
      `${CORE_URL}/oauth/upstream/${provider.slug}/start?${new URLSearchParams({
        response_type: "code",
        client_id: client.clientId,
        redirect_uri: REDIRECT_URI,
        state: "s1",
        scope: SCOPE,
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
      })}`,
      { redirect: "manual", headers: { Cookie: cookieHeader(jar) } }
    );
    expect(start.status).toBe(302);
    const to = new URL(start.headers.get("location") ?? "");
    expect(to.origin).toBe(fake.issuer);
    expect(to.searchParams.get("redirect_uri")).toBe(
      `${CORE_URL}/oauth/upstream/${provider.slug}/callback`
    );
    const cookie = start.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${UPSTREAM_COOKIE}=`));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/Path=\/oauth\/upstream/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=600/);
    expect(cookie!.split(";")[0].split("=")[1]).toBe(
      to.searchParams.get("state")
    );
  });

  it("signs a linked user in: consent, then a code whose amr is fed", async () => {
    const { user, claims } = await linkedUser(provider);
    const { jar, callback, location, verifier } = await loginFlow(
      fake,
      provider,
      { claims }
    );
    expect(callback.status).toBe(302);
    const code = await approveConsent(jar, location);
    const idToken = await exchange(code, verifier);
    expect(idToken.sub).toBe(user.id);
    expect(idToken.amr).toEqual(["fed"]);

    const identity = await prisma.userIdentity.findFirstOrThrow({
      where: { userId: user.id, providerId: provider.id },
    });
    expect(identity.lastLoginAt).not.toBeNull();
    const logins = await loginEntries(user.id);
    expect(logins).toHaveLength(1);
    expect(logins[0]).toMatchObject({ entityType: "User", entityId: user.id });
    expect(logins[0].metadata).toMatchObject({
      provider: provider.slug,
      auth_methods: ["fed"],
      client_id: client.clientId,
      consent: true,
    });
  });

  it("sends a user with TOTP to the 2FA step, and records fed then otp", async () => {
    const { user, claims } = await linkedUser(provider);
    const secret = await enableTotp(user.id);
    const { jar, location, verifier } = await loginFlow(fake, provider, {
      claims,
    });
    expect(location.searchParams.get("client_id")).toBe(client.clientId);
    // The provider alone is no sign-in while the second factor is due.
    expect(await loginEntries(user.id)).toHaveLength(0);
    const code = await approveConsent(
      jar,
      await verifyTotp(jar, location, secret)
    );
    expect((await exchange(code, verifier)).amr).toEqual(["fed", "otp"]);
    const logins = await loginEntries(user.id);
    expect(logins).toHaveLength(1);
    expect(logins[0].metadata).toMatchObject({
      provider: provider.slug,
      auth_methods: ["fed", "otp"],
    });
  });

  it("records no LOGIN when the TOTP step is abandoned", async () => {
    const { user, claims } = await linkedUser(provider);
    await enableTotp(user.id);
    const { location } = await loginFlow(fake, provider, { claims });
    expect(location.pathname).toBe("/login/2fa");
    expect(await loginEntries(user.id)).toHaveLength(0);
  });

  it("sends a user without TOTP to 2FA setup when a role requires it", async () => {
    const { user, claims } = await linkedUser(provider);
    await withRequires2faRole(user.id, async () => {
      const { location } = await loginFlow(fake, provider, { claims });
      expect(location.pathname).toBe("/login/2fa/setup");
    });
  });

  it("asks a user with TOTP for it under acr_values=mfa, then issues acr mfa", async () => {
    const { user, claims } = await linkedUser(provider);
    const secret = await enableTotp(user.id);
    const { jar, location, verifier } = await loginFlow(fake, provider, {
      claims,
      acrValues: ACR_MFA,
    });
    const code = await approveConsent(
      jar,
      await verifyTotp(jar, location, secret)
    );
    const idToken = await exchange(code, verifier);
    expect(idToken.acr).toBe(ACR_MFA);
    expect(idToken.amr).toEqual(["fed", "otp"]);
  });

  it("sends a user without TOTP to 2FA setup under acr_values=mfa", async () => {
    const { claims } = await linkedUser(provider);
    const { location } = await loginFlow(fake, provider, {
      claims,
      acrValues: ACR_MFA,
    });
    expect(location.pathname).toBe("/login/2fa/setup");
  });

  it("refuses a callback whose client was deleted mid-flow as session_expired", async () => {
    const doomed = await createTestClient();
    const { claims } = await linkedUser(provider);
    const { callbackUrl, jar } = await upstreamToCallback({
      provider: fake,
      slug: provider.slug,
      clientId: doomed.clientId,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      claims,
    });
    await prisma.oAuthClient.delete({ where: { id: doomed.id } });
    expectLoginFailure(
      await upstreamCallback(callbackUrl, jar),
      "session_expired",
      false
    );
  });

  it("sends a user without TOTP to 2FA setup when the instance requires it", async () => {
    const { claims } = await linkedUser(provider);
    await withTotpPolicy("required", async () => {
      const { location } = await loginFlow(fake, provider, { claims });
      expect(location.pathname).toBe("/login/2fa/setup");
      expect(location.searchParams.get("setup_grant")).toBeTruthy();
    });
  });

  it("refuses a deactivated user as account_inactive", async () => {
    const { user, claims } = await linkedUser(provider);
    await prisma.user.update({
      where: { id: user.id },
      data: { isActive: false },
    });
    const { callback } = await loginFlow(fake, provider, { claims });
    expectLoginFailure(callback, "account_inactive", true);
  });

  it("refuses an identity with no account as no_account", async () => {
    const { callback } = await loginFlow(fake, provider, {
      claims: { sub: `sub-${randomUUID()}` },
    });
    expectLoginFailure(callback, "no_account", true);
  });

  it("refuses a callback without the upstream cookie as session_expired", async () => {
    const { claims } = await linkedUser(provider);
    const { callbackUrl } = await upstreamToCallback({
      provider: fake,
      slug: provider.slug,
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      claims,
    });
    expectLoginFailure(
      await upstreamCallback(callbackUrl, new Map()),
      "session_expired",
      false
    );
  });

  it("refuses a cookie that does not match the state as session_expired", async () => {
    const { claims } = await linkedUser(provider);
    const { callbackUrl, jar } = await upstreamToCallback({
      provider: fake,
      slug: provider.slug,
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      claims,
    });
    jar.set(UPSTREAM_COOKIE, "not-the-state");
    expectLoginFailure(
      await upstreamCallback(callbackUrl, jar),
      "session_expired",
      false
    );
  });

  it("refuses a replayed state as session_expired", async () => {
    const { claims } = await linkedUser(provider);
    const { callbackUrl, jar } = await upstreamToCallback({
      provider: fake,
      slug: provider.slug,
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      claims,
    });
    const cookie = jar.get(UPSTREAM_COOKIE)!;
    const first = await upstreamCallback(callbackUrl, jar);
    expect(new URL(first.headers.get("location") ?? "").pathname).toBe(
      "/consent"
    );

    jar.set(UPSTREAM_COOKIE, cookie);
    expectLoginFailure(
      await upstreamCallback(callbackUrl, jar),
      "session_expired",
      false
    );
  });

  it("refuses a provider whose id_token has the wrong nonce as upstream_failed", async () => {
    const { claims } = await linkedUser(provider);
    fake.tamper({ nonce: "someone-elses-nonce" });
    const { callback } = await loginFlow(fake, provider, { claims });
    expectLoginFailure(callback, "upstream_failed", true);
  });

  it("refuses a token response over 1 MiB as upstream_failed", async () => {
    const { claims } = await linkedUser(provider);
    fake.tamper({ oversizeTokenResponse: true });
    const { callback } = await loginFlow(fake, provider, { claims });
    expectLoginFailure(callback, "upstream_failed", true);
  });

  it("refuses a subject longer than 255 characters as upstream_failed", async () => {
    const { callback } = await loginFlow(fake, provider, {
      claims: { sub: "s".repeat(256) },
    });
    expectLoginFailure(callback, "upstream_failed", true);
  });

  it("maps access_denied at the provider to upstream_cancelled", async () => {
    fake.tamper({ error: "access_denied" });
    const { callback } = await loginFlow(fake, provider);
    expectLoginFailure(callback, "upstream_cancelled", true);
  });

  it("refuses to start without the authorize step's session cookie", async () => {
    const res = await fetch(
      `${CORE_URL}/oauth/upstream/${provider.slug}/start?${new URLSearchParams({
        response_type: "code",
        client_id: client.clientId,
        redirect_uri: REDIRECT_URI,
        state: "s2",
        scope: SCOPE,
        code_challenge: "b".repeat(43),
        code_challenge_method: "S256",
      })}`,
      { redirect: "manual" }
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(
      `${env.UI_BASE_URL}/login`
    );
    expect(location.searchParams.get("error")).toBe("session_expired");
    expect(location.searchParams.get("client_id")).toBe(client.clientId);
    expect(res.headers.get("set-cookie") ?? "").not.toContain(UPSTREAM_COOKIE);
  });

  it("refuses to start for a client's unregistered redirect URI", async () => {
    const res = await fetch(
      `${CORE_URL}/oauth/upstream/${provider.slug}/start?${new URLSearchParams({
        response_type: "code",
        client_id: client.clientId,
        redirect_uri: "http://localhost:3000/elsewhere",
        state: "s3",
        scope: SCOPE,
        code_challenge: "c".repeat(43),
        code_challenge_method: "S256",
      })}`,
      { redirect: "manual" }
    );
    expect(res.status).toBe(400);
  });

  it("refuses to start at an unknown provider as provider_inactive", async () => {
    const authorizeQuery = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      state: "s4",
      scope: SCOPE,
      code_challenge: "d".repeat(43),
      code_challenge_method: "S256",
    });
    const jar: CookieJar = new Map();
    absorbCookies(
      jar,
      await fetch(`${CORE_URL}/oauth/authorize?${authorizeQuery}`, {
        redirect: "manual",
      })
    );
    const res = await fetch(
      `${CORE_URL}/oauth/upstream/no-such-provider/start?${authorizeQuery}`,
      { redirect: "manual", headers: { Cookie: cookieHeader(jar) } }
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("provider_inactive");
    expect(location.searchParams.get("client_id")).toBe(client.clientId);
  });
  it("refuses to start at a malformed slug with 400 invalid_request", async () => {
    const authorizeQuery = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      state: "s5",
      scope: SCOPE,
      code_challenge: "d".repeat(43),
      code_challenge_method: "S256",
    });
    const res = await fetch(
      `${CORE_URL}/oauth/upstream/Bad_Slug/start?${authorizeQuery}`,
      { redirect: "manual" }
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_request"
    );
  });

  it("sends a callback at a malformed slug to the login page as session_expired", async () => {
    const res = await fetch(
      `${CORE_URL}/oauth/upstream/Bad_Slug/callback?state=x&code=y`,
      { redirect: "manual" }
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("session_expired");
  });
});

describe("re-authentication at the provider", () => {
  let fake: FakeOidcProvider;
  let provider: Provider;
  const secondsAgo = (s: number) => Math.floor(Date.now() / 1000) - s;

  beforeAll(async () => {
    fake = await startFakeOidcProvider();
    provider = await createProvider(fake);
  });

  afterAll(async () => {
    await fake.close();
  });

  it("asks the provider for nothing when the request asks for nothing", async () => {
    const { claims } = await linkedUser(provider);
    await loginFlow(fake, provider, { claims });
    const sent = fake.lastAuthorizeQuery()!;
    expect(sent.has("prompt")).toBe(false);
    expect(sent.has("max_age")).toBe(false);
  });

  it("passes prompt=login and max_age on to the provider", async () => {
    const { claims } = await linkedUser(provider);
    await loginFlow(fake, provider, { claims, prompt: "login", maxAge: 300 });
    const sent = fake.lastAuthorizeQuery()!;
    expect(sent.get("prompt")).toBe("login");
    expect(sent.get("max_age")).toBe("300");
  });

  it("sends max_age=0 as prompt=login too", async () => {
    const { claims } = await linkedUser(provider);
    await loginFlow(fake, provider, { claims, maxAge: 0 });
    const sent = fake.lastAuthorizeQuery()!;
    expect(sent.get("prompt")).toBe("login");
    expect(sent.get("max_age")).toBe("0");
  });

  it("carries the provider's auth_time into core's tokens", async () => {
    const { claims } = await linkedUser(provider);
    const authTime = secondsAgo(3600);
    const { jar, location, verifier } = await loginFlow(fake, provider, {
      claims: { ...claims, auth_time: authTime },
    });
    const idToken = await exchange(
      await approveConsent(jar, location),
      verifier
    );
    expect(idToken.auth_time).toBe(authTime);
  });

  it("refuses an auth_time older than max_age as upstream_reauth_failed", async () => {
    const { claims } = await linkedUser(provider);
    const { callback } = await loginFlow(fake, provider, {
      claims: { ...claims, auth_time: secondsAgo(3600) },
      maxAge: 0,
    });
    expectLoginFailure(callback, "upstream_reauth_failed", true);
  });

  it("accepts a fresh auth_time under max_age=0", async () => {
    const { claims } = await linkedUser(provider);
    const authTime = secondsAgo(1);
    const { jar, location, verifier } = await loginFlow(fake, provider, {
      claims: { ...claims, auth_time: authTime },
      maxAge: 0,
    });
    const idToken = await exchange(
      await approveConsent(jar, location),
      verifier
    );
    expect(idToken.auth_time).toBe(authTime);
  });

  it("refuses a missing auth_time under a max_age that sent no prompt=login", async () => {
    const { claims } = await linkedUser(provider);
    const { callback } = await loginFlow(fake, provider, {
      claims,
      maxAge: 300,
    });
    expectLoginFailure(callback, "upstream_reauth_failed", true);
  });

  it("takes a missing auth_time under prompt=login as now", async () => {
    const { claims } = await linkedUser(provider);
    const before = Math.floor(Date.now() / 1000);
    const { jar, location, verifier } = await loginFlow(fake, provider, {
      claims,
      prompt: "login",
    });
    const idToken = await exchange(
      await approveConsent(jar, location),
      verifier
    );
    expect(idToken.auth_time).toBeGreaterThanOrEqual(before);
  });
});

describe("a provider that counts as MFA", () => {
  let fake: FakeOidcProvider;
  let provider: Provider;

  beforeAll(async () => {
    fake = await startFakeOidcProvider();
    provider = await createProvider(fake);
    // Turning it on through the API needs global admin.
    await prisma.identityProvider.update({
      where: { id: provider.id },
      data: { countsAsMfa: true },
    });
  });

  afterAll(async () => {
    await fake.close();
  });

  it("records fed and mfa, skipping core's TOTP", async () => {
    const { user, claims } = await linkedUser(provider);
    await enableTotp(user.id);
    const { jar, location, verifier } = await loginFlow(fake, provider, {
      claims,
    });
    const code = await approveConsent(jar, location);
    expect((await exchange(code, verifier)).amr).toEqual(["fed", "mfa"]);
  });

  it("satisfies acr_values=mfa", async () => {
    const { claims } = await linkedUser(provider);
    const { jar, location, verifier } = await loginFlow(fake, provider, {
      claims,
      acrValues: ACR_MFA,
    });
    const code = await approveConsent(jar, location);
    const idToken = await exchange(code, verifier);
    expect(idToken.acr).toBe(ACR_MFA);
    expect(idToken.amr).toEqual(["fed", "mfa"]);
  });

  it("needs no TOTP setup when the instance requires 2FA", async () => {
    const { claims } = await linkedUser(provider);
    await withTotpPolicy("required", async () => {
      const { jar, location, verifier } = await loginFlow(fake, provider, {
        claims,
      });
      const code = await approveConsent(jar, location);
      expect((await exchange(code, verifier)).amr).toEqual(["fed", "mfa"]);
    });
  });

  it("needs no TOTP setup when a role requires 2FA", async () => {
    const { user, claims } = await linkedUser(provider);
    await withRequires2faRole(user.id, async () => {
      const { jar, location, verifier } = await loginFlow(fake, provider, {
        claims,
      });
      const code = await approveConsent(jar, location);
      expect((await exchange(code, verifier)).amr).toEqual(["fed", "mfa"]);
    });
  });
});

describe("mix-up defence", () => {
  let fake: FakeOidcProvider;
  let first: Provider;
  let second: Provider;

  beforeAll(async () => {
    fake = await startFakeOidcProvider();
    first = await createProvider(fake);
    second = await createProvider(fake);
  });

  afterAll(async () => {
    await fake.close();
  });

  it("refuses a callback at another provider's URL as session_expired", async () => {
    const { claims } = await linkedUser(first);
    const { callbackUrl, jar } = await upstreamToCallback({
      provider: fake,
      slug: first.slug,
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      claims,
    });
    const elsewhere = new URL(callbackUrl);
    elsewhere.pathname = `/oauth/upstream/${second.slug}/callback`;
    expectLoginFailure(
      await upstreamCallback(elsewhere, jar),
      "session_expired",
      false
    );
  });
});

describe("a provider deactivated mid-flow", () => {
  let fake: FakeOidcProvider;
  let provider: Provider;

  beforeAll(async () => {
    fake = await startFakeOidcProvider();
    provider = await createProvider(fake);
  });

  afterAll(async () => {
    await fake.close();
  });

  it("refuses the callback as provider_inactive", async () => {
    const { claims } = await linkedUser(provider);
    const { callbackUrl, jar } = await upstreamToCallback({
      provider: fake,
      slug: provider.slug,
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      claims,
    });
    await deactivate(provider);
    expectLoginFailure(
      await upstreamCallback(callbackUrl, jar),
      "provider_inactive",
      true
    );
  });
});

describe("failed callbacks", () => {
  let fake: FakeOidcProvider;
  let provider: Provider;

  beforeAll(async () => {
    fake = await startFakeOidcProvider();
    provider = await createProvider(fake);
  });

  afterAll(async () => {
    await fake.close();
  });

  const noAccount = (ip: string) =>
    loginFlow(fake, provider, { claims: { sub: `sub-${randomUUID()}` }, ip });

  it("spend nothing without the upstream cookie, however many come", async () => {
    const ip = "198.51.100.71";
    const bare = () =>
      fetch(
        `${CORE_URL}/oauth/upstream/${provider.slug}/callback?state=x&code=y`,
        { redirect: "manual", headers: { "X-Forwarded-For": ip } }
      );
    for (let i = 0; i < 12; i++) {
      expectLoginFailure(await bare(), "session_expired", false);
    }
    const { claims } = await linkedUser(provider);
    const { callbackUrl, jar } = await upstreamToCallback({
      provider: fake,
      slug: provider.slug,
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      claims,
      ip,
    });
    for (let i = 0; i < 6; i++) {
      const wrong = new Map(jar);
      wrong.set(UPSTREAM_COOKIE, "not-the-state");
      expectLoginFailure(
        await upstreamCallback(callbackUrl, wrong, ip),
        "session_expired",
        false
      );
    }
    const res = await upstreamCallback(callbackUrl, jar, ip);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location") ?? "").pathname).toBe(
      "/consent"
    );
  });

  it("are limited per address once a session is consumed: the sixth is sent back as too_many_attempts", async () => {
    const ip = "198.51.100.77";
    for (let i = 0; i < 5; i++) {
      expectLoginFailure((await noAccount(ip)).callback, "no_account", true);
    }
    const refused = await noAccount(ip);
    expectLoginFailure(refused.callback, "too_many_attempts", true);

    const { claims } = await linkedUser(provider);
    const blocked = await loginFlow(fake, provider, { claims, ip });
    expectLoginFailure(blocked.callback, "too_many_attempts", true);

    expectLoginFailure(
      (await noAccount("198.51.100.78")).callback,
      "no_account",
      true
    );
  });

  it("a successful sign-in spends no attempt and clears none of the address's failures", async () => {
    const ip = "198.51.100.90";
    for (let i = 0; i < 4; i++) {
      expectLoginFailure((await noAccount(ip)).callback, "no_account", true);
    }
    const { claims } = await linkedUser(provider);
    const { location } = await loginFlow(fake, provider, { claims, ip });
    expect(location.pathname).toBe("/consent");
    expectLoginFailure((await noAccount(ip)).callback, "no_account", true);
    expectLoginFailure(
      (await noAccount(ip)).callback,
      "too_many_attempts",
      true
    );
  });
});
