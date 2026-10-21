import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import {
  absorbCookies,
  browserLogin,
  confirmLogout,
  cookieHeader,
  newPkce,
  type CookieJar,
} from "../utils/browserLogin.js";
import {
  BASE_URL,
  createTestClient,
  createTestUser,
  decodeJwt,
} from "./utils/test-helpers.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../utils/principals.js";

/**
 * LOGIN and LOGOUT audit entries: a fresh sign-in writes LOGIN, a silent
 * continuation does not; a user ending their own session writes LOGOUT,
 * whichever way they do it.
 */

const REDIRECT_URI = "http://localhost:3000/audit-login-logout-callback";

let client: Awaited<ReturnType<typeof createTestClient>>;

const entriesOf = (userId: string, action: "LOGIN" | "LOGOUT") =>
  prisma.auditLogEntry.findMany({
    where: { userId, action },
    orderBy: { createdAt: "asc" },
  });

const signIn = async (user?: Awaited<ReturnType<typeof createTestUser>>) => {
  const u = user ?? (await createTestUser());
  const login = await browserLogin({
    clientId: client.clientId,
    redirectUri: REDIRECT_URI,
    scope: "openid core:account",
    email: u.email,
    password: u.plainPassword,
  });
  const tokens = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.clientId,
      code: login.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: login.verifier,
    }),
  });
  expect(tokens.status).toBe(200);
  const body = (await tokens.json()) as {
    access_token: string;
    id_token: string;
  };
  return { user: u, jar: login.jar, ...body };
};

/**
 * A silent continuation in the browser, approved: the org switch, which
 * reuses the SSO session and shows a third-party client the consent screen
 * (`prompt=none` cannot). Returns the approval response and the verifier.
 */
const silentApproval = async (jar: CookieJar, userId: string) => {
  const orgId = await ensureTestOrganization(`audit-login-logout-${userId}`);
  await prisma.organizationMember.createMany({
    data: [{ organizationId: orgId, userId }],
    skipDuplicates: true,
  });
  const pkce = newPkce();
  const silent = await fetch(
    `${BASE_URL}/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      state: pkce.state,
      scope: "openid",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      org_id: orgId,
    })}`,
    { redirect: "manual", headers: { Cookie: cookieHeader(jar) } }
  );
  absorbCookies(jar, silent);
  const consent = new URL(silent.headers.get("location") ?? "");
  expect(consent.pathname).toMatch(/\/consent$/);
  const approved = await fetch(`${BASE_URL}/oauth/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify({
      session_token: consent.searchParams.get("session"),
      approved: true,
    }),
  });
  absorbCookies(jar, approved);
  return { approved, verifier: pkce.verifier };
};

/**
 * A silent login in the browser: a second token family under the same SSO
 * session. Returns its refresh token id.
 */
const silentFamily = async (jar: CookieJar, userId: string) => {
  const { approved, verifier } = await silentApproval(jar, userId);
  const { redirect_url } = (await approved.json()) as { redirect_url: string };
  const tokens = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.clientId,
      code: new URL(redirect_url).searchParams.get("code")!,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  expect(tokens.status).toBe(200);
  const { access_token } = (await tokens.json()) as { access_token: string };
  return (decodeJwt(access_token) as unknown as { sid: string }).sid;
};

const refreshTokenIds = async (userId: string) =>
  (
    await prisma.refreshToken.findMany({
      where: { userId },
      select: { id: true },
    })
  )
    .map((t) => t.id)
    .sort();

// Posted as the admin UI does, which gets JSON rather than a redirect.
const endSession = (jar: CookieJar, params: Record<string, string>) =>
  fetch(`${BASE_URL}/oauth/end-session`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(jar),
    },
    body: new URLSearchParams(params),
  });

beforeAll(async () => {
  client = await createTestClient({ redirectUris: [REDIRECT_URI] });
});

describe("LOGIN audit", () => {
  it("records a fresh sign-in once, with the client and the SSO session", async () => {
    const { user, id_token } = await signIn();
    const { sid } = decodeJwt(id_token) as unknown as { sid: string };

    const [login, ...more] = await entriesOf(user.id, "LOGIN");
    expect(more).toHaveLength(0);
    expect(login).toMatchObject({
      source: "tereo",
      entityType: "User",
      entityId: user.id,
      entityName: user.email,
      userEmail: user.email,
    });
    expect(login.metadata).toEqual({
      client_id: client.clientId,
      sid,
      auth_methods: ["pwd"],
      fresh_login: true,
      consent: true,
      scopes: ["openid", "core:account"],
    });

    // Signing in again with the password is a new login.
    await signIn(user);
    expect(await entriesOf(user.id, "LOGIN")).toHaveLength(2);
  });

  it("records a consent approved on a continued SSO session", async () => {
    const { user, jar, id_token } = await signIn();
    const { sid } = decodeJwt(id_token) as unknown as { sid: string };

    const { approved } = await silentApproval(jar, user.id);
    expect(approved.status).toBe(200);
    const [, consented, ...more] = await entriesOf(user.id, "LOGIN");
    expect(more).toHaveLength(0);
    expect(consented).toMatchObject({ entityType: "User", entityId: user.id });
    expect(consented.metadata).toEqual({
      client_id: client.clientId,
      sid,
      auth_methods: ["pwd"],
      fresh_login: false,
      consent: true,
      scopes: ["openid"],
    });
  });

  it("is listed by the audit API's action filter", async () => {
    const { user } = await signIn();
    const token = await getTestPrincipalToken({
      organizationId: null,
      permissions: ["audit-logs.admin"],
    });
    const res = await fetch(
      `${BASE_URL}/v1/audit/entries?${new URLSearchParams({
        "filter[organizationId]": "none",
        "filter[userId]": user.id,
        "filter[action]": "LOGIN",
      })}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { action: string }[] };
    expect(body.data.map((e) => e.action)).toEqual(["LOGIN"]);
  });

  it("cannot be written by a service through the audit API", async () => {
    const token = await getTestPrincipalToken({
      permissions: ["audit-logs.write"],
    });
    const { user } = await signIn();
    const res = await fetch(`${BASE_URL}/v1/audit/entries`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: "test-service",
        userId: user.id,
        action: "LOGIN",
        entityType: "User",
        entityId: user.id,
      }),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("action");
  });
});

describe("LOGOUT audit", () => {
  it("records end-session with a hint", async () => {
    const { user, jar, id_token } = await signIn();
    const { sid } = decodeJwt(id_token) as unknown as { sid: string };

    const sessionIds = await refreshTokenIds(user.id);

    const res = await endSession(jar, { id_token_hint: id_token });
    expect(res.status).toBe(200);

    const [logout, ...more] = await entriesOf(user.id, "LOGOUT");
    expect(more).toHaveLength(0);
    expect(logout).toMatchObject({ entityType: "User", entityId: user.id });
    expect(logout.metadata).toEqual({
      client_id: client.clientId,
      sids: [sid],
      sessionIds,
      method: "id_token_hint",
    });
  });

  it("records nothing for an unconfirmed end-session, and the confirm once", async () => {
    const { user, jar, id_token } = await signIn();
    const { sid } = decodeJwt(id_token) as unknown as { sid: string };

    const sessionIds = await refreshTokenIds(user.id);

    const res = await endSession(jar, { client_id: client.clientId });
    expect(await entriesOf(user.id, "LOGOUT")).toHaveLength(0);

    expect((await confirmLogout(jar, res)).status).toBe(200);
    const [logout, ...more] = await entriesOf(user.id, "LOGOUT");
    expect(more).toHaveLength(0);
    expect(logout.metadata).toEqual({
      client_id: client.clientId,
      sids: [sid],
      sessionIds,
      method: "confirm",
    });
  });

  it("lists every token family the browser's end-session revoked", async () => {
    const { user, jar, id_token } = await signIn();
    const { sid } = decodeJwt(id_token) as unknown as { sid: string };
    await silentFamily(jar, user.id);
    const sessionIds = await refreshTokenIds(user.id);
    expect(sessionIds).toHaveLength(2);

    const res = await endSession(jar, { id_token_hint: id_token });
    expect(res.status).toBe(200);

    const [logout] = await entriesOf(user.id, "LOGOUT");
    expect(logout.metadata).toMatchObject({ sids: [sid] });
    expect(
      [...(logout.metadata as { sessionIds: string[] }).sessionIds].sort()
    ).toEqual(sessionIds);
  });

  it("lists the siblings and SSO session a single account revoke ended", async () => {
    const { user, jar, id_token, access_token } = await signIn();
    const { sid } = decodeJwt(id_token) as unknown as { sid: string };
    const requested = (decodeJwt(access_token) as unknown as { sid: string })
      .sid;
    const sibling = await silentFamily(jar, user.id);

    const res = await fetch(`${BASE_URL}/v1/account/sessions/${requested}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(res.status).toBe(204);

    const [logout, ...more] = await entriesOf(user.id, "LOGOUT");
    expect(more).toHaveLength(0);
    expect(logout.metadata).toEqual({
      // The token is a third-party client's, delegated by core:account.
      clientId: client.clientId,
      action: "sessions_revoked",
      sessionIds: [requested, sibling],
      ssoSessionIds: [sid],
      method: "account",
    });
  });

  it("records signing out of sessions from the account API", async () => {
    const { user, access_token } = await signIn();
    await signIn(user);

    const res = await fetch(`${BASE_URL}/v1/account/sessions`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(res.status).toBe(200);

    const [logout] = await entriesOf(user.id, "LOGOUT");
    expect(logout.metadata).toMatchObject({
      action: "sessions_revoked",
      method: "account",
    });
  });
});
