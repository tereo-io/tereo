import { prisma } from "../../utils/db/prisma.js";
import { describe, it, expect } from "vitest";
import {
  absorbCookies,
  browserLogin,
  cookieHeader,
  newPkce,
  type CookieJar,
} from "../support/browserLogin.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../support/principals.js";
import {
  BASE_URL,
  createTestClient,
  createTestUser,
  createUserRequiringTotpSetup,
  getUiAccessTokenForUser,
  loginToTotpSetup,
  startTotpSetup,
} from "../support/auth.js";

/**
 * A login step past the password (consent, an organization pick, 2FA) is
 * worth a code. It must not outlive a password change or reset, nor the SSO
 * session it continues when it was let in without a password.
 */
const SCOPE = "openid offline_access";

const toConsent = async (
  client: { clientId: string; redirectUris: string[] },
  user: { email: string; plainPassword: string }
) => {
  const jar: CookieJar = new Map();
  const pkce = newPkce();
  const params = {
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUris[0],
    state: pkce.state,
    scope: SCOPE,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  };
  const start = await fetch(
    `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
    { redirect: "manual" }
  );
  absorbCookies(jar, start);
  const submit = await fetch(`${BASE_URL}/oauth/authorize`, {
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
  const { redirect_url } = (await submit.json()) as { redirect_url: string };
  const session = new URL(redirect_url).searchParams.get("session")!;
  expect(session).toBeTruthy();
  return { jar, session };
};

const approve = async (jar: CookieJar, session: string) => {
  const res = await fetch(`${BASE_URL}/oauth/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify({ session_token: session, approved: true }),
  });
  const body = (await res.json()) as { redirect_url?: string };
  const code = body.redirect_url
    ? new URL(body.redirect_url).searchParams.get("code")
    : null;
  return { status: res.status, code };
};

describe("a login step past the password, pending at a password change", () => {
  it("cannot be completed into tokens afterwards", async () => {
    const client = await createTestClient();
    const user = await createTestUser();
    // The attacker, holding the old password, stops at the consent page.
    const attacker = await toConsent(client, user);

    // The owner changes the password to lock them out.
    const ownerToken = await getUiAccessTokenForUser({
      id: user.id,
      email: user.email,
      plainPassword: user.plainPassword,
    });
    const change = await fetch(`${BASE_URL}/v1/account/password`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        currentPassword: user.plainPassword,
        newPassword: "An0ther-Long-Passw0rd!",
      }),
    });
    expect(change.status).toBe(200);

    const approved = await approve(attacker.jar, attacker.session);
    expect(approved).toEqual({ status: 400, code: null });
  });
});

describe("a 2FA setup grant pending at an admin password reset", () => {
  it("can no longer enrol an authenticator", async () => {
    const client = await createTestClient();
    const user = await createUserRequiringTotpSetup();
    // The attacker, holding the old password, is sent to enrol 2FA.
    const attacker = await loginToTotpSetup(user, client);

    // An admin resets the password, signing the user out everywhere.
    const admin = await getTestPrincipalToken({ permissions: ["users.write"] });
    const reset = await fetch(`${BASE_URL}/v1/admin/users/${user.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${admin}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: "An0ther-Long-Passw0rd!" }),
    });
    expect(reset.status).toBe(200);

    // Otherwise the attacker's authenticator would be the one the owner is
    // asked for at their next login.
    const started = await startTotpSetup(
      { setup_grant: attacker.setupGrant },
      attacker.grantCookie
    );
    expect(started.status).toBe(400);
  });
});

const REDIRECT_URI = "http://localhost:3000/pending-login-steps";

describe("an org-switch consent pending at logout", () => {
  it("cannot be approved into a code or a new SSO session", async () => {
    const client = await createTestClient({ redirectUris: [REDIRECT_URI] });
    const user = await createTestUser();
    const { jar, code, verifier } = await browserLogin({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      scope: SCOPE,
      email: user.email,
      password: user.plainPassword,
    });
    const tokenRes = await fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.clientId,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { refresh_token: string };

    const orgId = await ensureTestOrganization(`oauth-orgswitch-${user.id}`);
    await prisma.organizationMember.create({
      data: { organizationId: orgId, userId: user.id },
    });

    // Org switch with only the SSO cookie: a consent session, no password.
    const pkce = newPkce();
    const sw = await fetch(
      `${BASE_URL}/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: client.clientId,
        redirect_uri: REDIRECT_URI,
        state: pkce.state,
        scope: SCOPE,
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        org_id: orgId,
      })}`,
      { redirect: "manual", headers: { Cookie: cookieHeader(jar) } }
    );
    absorbCookies(jar, sw);
    expect(sw.status).toBe(302);
    const consentPage = new URL(sw.headers.get("location")!);
    expect(consentPage.pathname).toMatch(/\/consent$/);
    const consentSession = consentPage.searchParams.get("session")!;

    // The client logs the browser out: revocation of its refresh token ends
    // the SSO session and every family under it.
    const revoke = await fetch(`${BASE_URL}/oauth/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader(jar),
      },
      body: new URLSearchParams({
        client_id: client.clientId,
        token: tokens.refresh_token,
      }),
    });
    absorbCookies(jar, revoke);
    expect(revoke.status).toBe(200);
    expect(await prisma.userSession.count({ where: { userId: user.id } })).toBe(
      0
    );

    // The consent page left open is approved afterwards.
    const approve = await fetch(`${BASE_URL}/oauth/consent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({ session_token: consentSession, approved: true }),
    });
    expect(approve.status).toBe(400);
    expect(await prisma.userSession.count({ where: { userId: user.id } })).toBe(
      0
    );
  });
});
