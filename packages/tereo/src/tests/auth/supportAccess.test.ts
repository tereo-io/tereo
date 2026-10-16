import { BASE_URL, HTTP_STATUS, createTestUser } from "./utils/test-helpers.js";
import { generateRandomString, hashFlowToken } from "../../utils/crypto.js";
import { issueAuthorizationCode } from "../../utils/authorization.js";
import { LOGIN_CLIENT } from "../../definitions/index.js";
import { handleRefreshToken } from "../../utils/auth.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import type { Request, Response } from "express";
import db from "../../utils/db/index.js";
import { randomBytes } from "crypto";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../webhooks/utils/test-helpers.js";
import {
  absorbCookies,
  browserLogin,
  cookieHeader,
  newPkce,
  type CookieJar,
} from "../utils/browserLogin.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../utils/principals.js";

/**
 * A holder of `organizations.support-access` may select any active,
 * unarchived organization without being a member, acting there with their
 * global roles only; each such selection is audited and emitted under that
 * organization.
 */

const EVENT = "auth.organization.support-access";

let loginRedirectUri = "";
let loginClientRecord: Awaited<ReturnType<typeof db.clients.getByClientId>>;

beforeAll(async () => {
  const loginClient = await prisma.oAuthClient.findFirstOrThrow({
    where: { clientId: LOGIN_CLIENT.clientId },
  });
  loginRedirectUri = loginClient.redirectUris[0];
  loginClientRecord = await db.clients.getByClientId(LOGIN_CLIENT.clientId);
});

const newOrg = () =>
  ensureTestOrganization(`support-${randomBytes(8).toString("hex")}`);

const grantSupportAccess = (userId: string) =>
  getTestPrincipalToken({
    userId,
    permissions: ["organizations.support-access"],
  });

const signIn = async () => {
  const user = await createTestUser();
  const { jar } = await browserLogin({
    clientId: LOGIN_CLIENT.clientId,
    redirectUri: loginRedirectUri,
    scope: "openid",
    email: user.email,
    password: user.plainPassword,
  });
  return { user, jar };
};

const switchTo = async (jar: CookieJar, orgId: string) => {
  const pkce = newPkce();
  const res = await fetch(
    `${BASE_URL}/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: LOGIN_CLIENT.clientId,
      redirect_uri: loginRedirectUri,
      state: pkce.state,
      scope: "openid",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      org_id: orgId,
    })}`,
    { redirect: "manual", headers: { Cookie: cookieHeader(jar) } }
  );
  absorbCookies(jar, res);
  expect(res.status).toBe(302);
  return { location: new URL(res.headers.get("location") ?? ""), pkce };
};

const exchange = async (code: string, verifier: string) => {
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: LOGIN_CLIENT.clientId,
      code,
      redirect_uri: loginRedirectUri,
      code_verifier: verifier,
    }),
  });
  return res;
};

const claims = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as {
    org_id?: string;
    permissions?: string[];
  };

const supportEntries = (userId: string, orgId: string) =>
  prisma.auditLogEntry.findMany({
    where: {
      userId,
      organizationId: orgId,
      entityType: "Organization",
      entityId: orgId,
      metadata: { path: ["action"], equals: "support_access" },
    },
  });

describe("support access at authorize", () => {
  it("lets a holder switch into an organization they are not a member of", async () => {
    const orgId = await newOrg();
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(orgId),
      { eventTypes: [EVENT] }
    );
    const { user, jar } = await signIn();
    await grantSupportAccess(user.id);

    const { location, pkce } = await switchTo(jar, orgId);
    expect(`${location.origin}${location.pathname}`).toBe(loginRedirectUri);
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();

    const res = await exchange(code!, pkce.verifier);
    expect(res.status).toBe(HTTP_STATUS.OK);
    const { access_token } = (await res.json()) as { access_token: string };
    const token = claims(access_token);
    expect(token.org_id).toBe(orgId);
    expect([...(token.permissions ?? [])].sort()).toEqual(
      [...(await db.roles.getUserPermissions(user.id, null))].sort()
    );

    const entries = await supportEntries(user.id, orgId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "LOGIN" });
    expect(entries[0].metadata).toMatchObject({
      client_id: LOGIN_CLIENT.clientId,
    });

    await waitFor(
      async () =>
        (await prisma.webhookDelivery.count({
          where: {
            webhookEndpointId: endpoint.id,
            eventType: EVENT,
            payload: { path: ["data", "userId"], equals: user.id },
          },
        })) > 0,
      10_000
    );
    const delivery = await prisma.webhookDelivery.findFirstOrThrow({
      where: { webhookEndpointId: endpoint.id, eventType: EVENT },
    });
    expect((delivery.payload as { data: unknown }).data).toEqual({
      userId: user.id,
      organizationId: orgId,
      clientId: LOGIN_CLIENT.clientId,
    });
  });

  it("sends a non-holder to the password login", async () => {
    const orgId = await newOrg();
    const { user, jar } = await signIn();

    const { location } = await switchTo(jar, orgId);
    expect(location.pathname).toMatch(/\/login$/);
    expect(location.searchParams.get("code")).toBeNull();
    expect(await supportEntries(user.id, orgId)).toHaveLength(0);
  });

  it("refuses an inactive organization even to a holder", async () => {
    const orgId = await newOrg();
    await prisma.organization.update({
      where: { id: orgId },
      data: { isActive: false },
    });
    const { user, jar } = await signIn();
    await grantSupportAccess(user.id);

    const { location } = await switchTo(jar, orgId);
    expect(location.pathname).toMatch(/\/login$/);
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("refuses an archived organization even to a holder", async () => {
    const orgId = await newOrg();
    await prisma.organization.update({
      where: { id: orgId },
      data: { archivedAt: new Date() },
    });
    const { user, jar } = await signIn();
    await grantSupportAccess(user.id);

    const { location } = await switchTo(jar, orgId);
    expect(location.pathname).toMatch(/\/login$/);
  });

  it("writes no support entry when a member switches into their own organization", async () => {
    const orgId = await newOrg();
    const { user, jar } = await signIn();
    await grantSupportAccess(user.id);
    await prisma.organizationMember.create({
      data: { organizationId: orgId, userId: user.id },
    });

    const { location } = await switchTo(jar, orgId);
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(await supportEntries(user.id, orgId)).toHaveLength(0);
  });
});

describe("support access at code issue", () => {
  it("writes no support entry when the holder lost the permission before the code", async () => {
    const orgId = await newOrg();
    const user = await createTestUser();
    const pkce = newPkce();
    const req = { cookies: {} } as unknown as Request;
    const res = {
      cookie: () => res,
      clearCookie: () => res,
    } as unknown as Response;

    const redirect = await issueAuthorizationCode(req, res, loginClientRecord, {
      userId: user.id,
      organizationId: orgId,
      redirectUri: loginRedirectUri,
      scopes: ["openid"],
      state: pkce.state,
      codeChallenge: pkce.challenge,
      codeChallengeMethod: "S256",
      nonce: null,
      authTime: new Date(),
      maxAge: null,
      acrValues: null,
      authMethods: ["pwd"],
      userSessionId: null,
    });
    expect(new URL(redirect).searchParams.get("code")).toBeTruthy();
    expect(await supportEntries(user.id, orgId)).toHaveLength(0);
  });

  it("writes no second entry for a silent re-issue in the session's organization", async () => {
    const orgId = await newOrg();
    const { user, jar } = await signIn();
    await grantSupportAccess(user.id);
    await switchTo(jar, orgId);
    expect(await supportEntries(user.id, orgId)).toHaveLength(1);

    const pkce = newPkce();
    const silent = await fetch(
      `${BASE_URL}/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: LOGIN_CLIENT.clientId,
        redirect_uri: loginRedirectUri,
        state: pkce.state,
        scope: "openid",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        prompt: "none",
      })}`,
      { redirect: "manual", headers: { Cookie: cookieHeader(jar) } }
    );
    expect(silent.status).toBe(302);
    const location = new URL(silent.headers.get("location") ?? "");
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(await supportEntries(user.id, orgId)).toHaveLength(1);
  });
});

describe("support access at the org picker", () => {
  const createOrgSelectSession = async (userId: string) => {
    const sessionToken = generateRandomString(32);
    await prisma.orgSelectionSession.create({
      data: {
        tokenHash: hashFlowToken(sessionToken),
        userId,
        clientId: loginClientRecord.id,
        redirectUri: loginRedirectUri,
        scopes: ["openid"],
        state: generateRandomString(16),
        codeChallenge: "test-challenge",
        codeChallengeMethod: "S256",
        nonce: null,
        authTime: new Date(),
        maxAge: null,
        acrValues: null,
        prompt: null,
        authMethods: ["pwd"],
        expiresAt: new Date(Date.now() + 120_000),
      },
    });
    return sessionToken;
  };

  const submit = (sessionToken: string, orgId: string) =>
    fetch(`${BASE_URL}/oauth/org-select/submit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `tereo_org_select_session_${LOGIN_CLIENT.clientId}=${sessionToken}`,
      },
      body: JSON.stringify({
        session_token: sessionToken,
        organization_id: orgId,
      }),
    });

  it("accepts a non-member organization from a holder", async () => {
    const orgId = await newOrg();
    const user = await createTestUser();
    await grantSupportAccess(user.id);

    const res = await submit(await createOrgSelectSession(user.id), orgId);
    expect(res.status).toBe(HTTP_STATUS.OK);
    const { redirect_url } = (await res.json()) as { redirect_url: string };
    expect(new URL(redirect_url).searchParams.get("code")).toBeTruthy();
    expect(await supportEntries(user.id, orgId)).toHaveLength(1);
  });

  it("refuses a non-member organization from a non-holder", async () => {
    const orgId = await newOrg();
    const user = await createTestUser();

    const res = await submit(await createOrgSelectSession(user.id), orgId);
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(((await res.json()) as { error: string }).error).toBe(
      "user_not_in_organization"
    );
  });
});

describe("support access at refresh", () => {
  it("keeps the grant while the holder keeps the permission, and revokes it after", async () => {
    const orgId = await newOrg();
    const user = await createTestUser();
    await grantSupportAccess(user.id);
    const token = randomBytes(32).toString("base64url");
    await db.refreshTokens.create({
      token,
      clientId: loginClientRecord.id,
      userId: user.id,
      organizationId: orgId,
      scopes: ["openid", "offline_access"],
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const refresh = async (refreshToken: string) =>
      (await handleRefreshToken(loginClientRecord, {
        grant_type: "refresh_token",
        client_id: LOGIN_CLIENT.clientId,
        refresh_token: refreshToken,
      })) as { access_token: string; refresh_token: string };

    const rotated = await refresh(token);
    expect(rotated.refresh_token).toBeTruthy();
    expect(claims(rotated.access_token).org_id).toBe(orgId);
    // A refresh is not a new selection.
    expect(await supportEntries(user.id, orgId)).toHaveLength(0);

    await prisma.userRole.deleteMany({ where: { userId: user.id } });

    await expect(refresh(rotated.refresh_token)).rejects.toThrow(
      "invalid_grant"
    );
    expect(
      await prisma.refreshToken.count({
        where: { userId: user.id, organizationId: orgId, revokedAt: null },
      })
    ).toBe(0);
  });
});
