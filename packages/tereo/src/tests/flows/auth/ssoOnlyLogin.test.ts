// @module-tag int
// @module-tag auth
import { getTestPrincipalToken } from "../../support/principals.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestClient } from "../../support/auth/clients.js";
import { generateUniqueId } from "../../support/auth/crypto.js";
import { upstreamLogin } from "../../support/upstreamLogin.js";
import { createTestUser } from "../../support/auth/users.js";
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

const REDIRECT_URI = "http://localhost:3000/callback";
const SCOPE = "openid profile email";
const LINK_GRANT_COOKIE = "tereo_identity_link_grant";

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

describe("password login on an SSO-only domain", () => {
  it("refuses a linked user's correct password with sso_required", async () => {
    const user = await ssoUser();
    await prisma.userIdentity.create({
      data: {
        userId: user.id,
        providerId: provider.id,
        subject: `sub-${randomUUID()}`,
      },
    });

    const { res } = await submitPassword(user.email, user.plainPassword);
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("sso_required");
    expect(body.provider).toBe(provider.slug);
    expect(body.error_description).toContain(provider.displayName);
  });

  it("answers sso_required when the domain's provider is inactive", async () => {
    const owner = await createProvider();
    const user = await ssoUser(owner);
    await prisma.identityProvider.update({
      where: { id: owner.id },
      data: { isActive: false },
    });

    const { res } = await submitPassword(user.email, user.plainPassword);
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("sso_required");
    expect(body.provider).toBe(owner.slug);
  });

  it("answers an unknown email and a wrong password identically", async () => {
    const user = await ssoUser();
    const domain = user.email.split("@")[1];

    const wrong = await submitPassword(user.email, "Not-The-Password-1!");
    const unknown = await submitPassword(
      `nobody-${generateUniqueId().toLowerCase()}@${domain}`,
      user.plainPassword
    );
    expect(wrong.res.status).toBe(401);
    expect(unknown.res.status).toBe(401);
    const wrongBody = await wrong.res.text();
    expect(wrongBody).toBe(await unknown.res.text());
    expect(JSON.parse(wrongBody)).toEqual({
      error: "access_denied",
      error_description: "Invalid credentials",
    });
    expect(
      await prisma.identityLinkGrant.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("issues a link grant for an unlinked user's correct password", async () => {
    const user = await ssoUser();
    const { page, jar, grant } = await toLinkRequired(user);

    expect(page.searchParams.get("provider")).toBe(provider.slug);
    expect(page.searchParams.get("client_id")).toBe(client.clientId);
    expect(page.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(page.searchParams.get("code_challenge")).toBeTruthy();
    expect(jar.get(`${LINK_GRANT_COOKIE}_${client.clientId}`)).toBe(grant);
    expect(jar.get(`tereo_session_${client.clientId}`)).toBeUndefined();
    // Nothing is signed in yet, and the password still stands.
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(stored.passwordHash).not.toBeNull();
  });
});

describe("sign-in through another provider on an SSO-only domain", () => {
  const throughOther = (claims: { sub: string; email?: string }) =>
    upstreamLogin({
      provider: fake,
      slug: other.slug,
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      claims: { email_verified: true, ...claims },
      ip: freshIp(),
    });

  it("refuses a user linked there with sso_required, naming the domain's provider", async () => {
    const user = await ssoUser();
    const sub = `sub-${randomUUID()}`;
    const identity = await prisma.userIdentity.create({
      data: { userId: user.id, providerId: other.id, subject: sub },
    });
    const { callback, location } = await throughOther({ sub });
    expectLoginError(callback, "sso_required");
    expect(location.searchParams.get("provider")).toBe(provider.slug);
    const after = await prisma.userIdentity.findUniqueOrThrow({
      where: { id: identity.id },
    });
    expect(after.lastLoginAt).toBeNull();
  });

  it("refuses to claim an invite there, leaving it unclaimed", async () => {
    const user = await ssoUser();
    await prisma.identityInvite.create({
      data: {
        userId: user.id,
        providerId: other.id,
        createdBy: SYSTEM_USER_ID,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const { callback } = await throughOther({
      sub: `sub-${randomUUID()}`,
      email: user.email,
    });
    expectLoginError(callback, "sso_required");
    expect(
      await prisma.userIdentity.count({ where: { userId: user.id } })
    ).toBe(0);
    expect(
      await prisma.identityInvite.count({ where: { userId: user.id } })
    ).toBe(1);
  });

  it("still signs in through the domain's own provider", async () => {
    const user = await ssoUser();
    const sub = `sub-${randomUUID()}`;
    await prisma.userIdentity.create({
      data: { userId: user.id, providerId: provider.id, subject: sub },
    });
    const { location } = await upstreamLogin({
      provider: fake,
      slug: provider.slug,
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      claims: { sub },
      ip: freshIp(),
    });
    expect(location.pathname).toBe("/consent");
  });
});
