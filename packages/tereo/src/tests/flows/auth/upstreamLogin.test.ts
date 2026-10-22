// @module-tag int
// @module-tag auth
import { encryptTotpSecret, generateTotpSecret } from "../../../utils/totp.js";
import { getTestPrincipalToken } from "../../support/principals.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upstreamLogin } from "../../support/upstreamLogin.js";
import { prisma } from "../../../utils/db/prisma.js";
import { CORE_URL } from "../../support/coreUrl.js";
import { randomUUID } from "node:crypto";
import {
  startFakeOidcProvider,
  type FakeOidcProvider,
} from "../../support/fakeOidcProvider.js";
import {
  absorbCookies,
  cookieHeader,
  type CookieJar,
} from "../../support/browserLogin.js";
import {
  createTestClient,
  createTestRole,
  createTestUser,
  decodeJwt,
  generateTotpCode,
  generateUniqueId,
} from "../../support/auth.js";

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

  it("sends a user without TOTP to 2FA setup when the instance requires it", async () => {
    const { claims } = await linkedUser(provider);
    await withTotpPolicy("required", async () => {
      const { location } = await loginFlow(fake, provider, { claims });
      expect(location.pathname).toBe("/login/2fa/setup");
      expect(location.searchParams.get("setup_grant")).toBeTruthy();
    });
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
