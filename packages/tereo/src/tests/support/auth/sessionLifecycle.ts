import { ensureTestOrganization } from "../principals.js";
import { hashFlowToken } from "../../../utils/crypto.js";
import { prisma } from "../../../utils/db/prisma.js";
import { createTestUser } from "./users.js";
import { BASE_URL } from "./constants.js";
import { expect } from "vitest";
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateUniqueId,
} from "./crypto.js";

// Shared by the session flow tests (logout, revocation, lifecycle): password
// login, consent and silent re-login against one third-party test client.
export const REDIRECT_URI = "http://localhost:3000/session-lifecycle-callback";
export const POST_LOGOUT_URI = "http://localhost:3000/session-lifecycle-logout";
// The tests call /account and /admin with these tokens.
export const SCOPE =
  "openid profile email offline_access core:account core:admin";

export type Jar = Map<string, string>;

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in: number;
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  orgId: string;
}

export interface Err {
  error?: string;
  error_description?: string;
}

/** Helpers bound to the client the calling file creates in its beforeAll. */
export const sessionLifecycleHelpers = (
  clientOf: () => { clientId: string }
) => {
  const absorb = (jar: Jar, res: Response) => {
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!value || /expires=Thu, 01 Jan 1970/i.test(cookie)) jar.delete(name);
      else jar.set(name, value);
    }
  };

  const cookieHeader = (jar: Jar) =>
    [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

  const userSessionCookieName = () =>
    `tereo_user_session_${clientOf().clientId}`;

  const newPkce = () => {
    const verifier = generateCodeVerifier();
    return {
      verifier,
      challenge: generateCodeChallenge(verifier),
      state: generateUniqueId(),
    };
  };

  const authorizeUrl = (
    pkce: ReturnType<typeof newPkce>,
    extra: Record<string, string> = {}
  ) => {
    const url = new URL(`${BASE_URL}/oauth/authorize`);
    const params: Record<string, string> = {
      response_type: "code",
      client_id: clientOf().clientId,
      redirect_uri: REDIRECT_URI,
      state: pkce.state,
      scope: SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      ...extra,
    };
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  };

  const getAuthorize = async (
    jar: Jar,
    pkce: ReturnType<typeof newPkce>,
    extra: Record<string, string> = {}
  ) => {
    const res = await fetch(authorizeUrl(pkce, extra), {
      redirect: "manual",
      headers: { Cookie: cookieHeader(jar) },
    });
    absorb(jar, res);
    expect(res.status).toBe(302);
    return new URL(res.headers.get("location") ?? "");
  };

  const createUser = async (): Promise<TestUser> => {
    const user = await createTestUser();
    const orgId = await ensureTestOrganization(`session-lifecycle-${user.id}`);
    await prisma.organizationMember.create({
      data: { organizationId: orgId, userId: user.id },
    });
    return {
      id: user.id,
      email: user.email,
      password: user.plainPassword,
      orgId,
    };
  };

  /** Approves a consent session; returns the authorization code. */
  const approve = async (jar: Jar, sessionToken: string) => {
    const res = await fetch(`${BASE_URL}/oauth/consent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({ session_token: sessionToken, approved: true }),
    });
    absorb(jar, res);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { redirect_url: string };
    const code = new URL(body.redirect_url).searchParams.get("code");
    expect(code).toBeTruthy();
    return code!;
  };

  const exchange = async (code: string, verifier: string) => {
    const res = await fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientOf().clientId,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });
    return { status: res.status, body: (await res.json()) as TokenSet & Err };
  };

  const refresh = async (refreshToken: string) => {
    const res = await fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientOf().clientId,
        refresh_token: refreshToken,
      }),
    });
    return { status: res.status, body: (await res.json()) as TokenSet & Err };
  };

  const me = async (accessToken: string) => {
    const res = await fetch(`${BASE_URL}/v1/account/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return { status: res.status, body: (await res.json()) as Err };
  };

  /** Password login through to consent; returns the code and its verifier. */
  const loginToCode = async (
    user: TestUser,
    jar: Jar,
    extra: Record<string, string> = {}
  ) => {
    const pkce = newPkce();
    const login = await getAuthorize(jar, pkce, extra);
    expect(login.pathname).toMatch(/\/login$/);

    const res = await fetch(`${BASE_URL}/oauth/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({
        email: user.email,
        password: user.password,
        client_id: clientOf().clientId,
        redirect_uri: REDIRECT_URI,
        state: pkce.state,
        scope: SCOPE,
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        ...extra,
      }),
    });
    absorb(jar, res);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { redirect_url: string };
    const session = new URL(body.redirect_url).searchParams.get("session");
    expect(session).toBeTruthy();
    const code = await approve(jar, session!);
    return { code, verifier: pkce.verifier };
  };

  /** A full password login. The jar keeps the SSO cookie it leaves behind. */
  const login = async (user: TestUser, jar: Jar = new Map()) => {
    const { code, verifier } = await loginToCode(user, jar);
    const tokens = await exchange(code, verifier);
    expect(tokens.status).toBe(200);
    expect(tokens.body.refresh_token).toBeTruthy();
    return { jar, tokens: tokens.body };
  };

  /**
   * Tries to get tokens without a password: authorize with only the SSO cookie
   * (`prompt=none`, or the `org_id` org-switch path), then consent and exchange.
   * `loggedOut` means core sent the browser to the login page or answered
   * `login_required`. A `prompt=none` that accepts the session answers this
   * third-party client `consent_required`; tokens are then got by the org
   * switch to the session's user's organization, which shows consent.
   */
  const silentLogin = async (
    jar: Jar,
    extra: Record<string, string> = { prompt: "none" }
  ) => {
    const pkce = newPkce();
    let location = await getAuthorize(jar, pkce, extra);
    const loggedOut = () =>
      location.pathname.endsWith("/login") ||
      location.searchParams.get("error") === "login_required";
    if (loggedOut()) return { loggedOut: true as const, location };
    if (location.searchParams.get("error") === "consent_required") {
      location = await getAuthorize(jar, pkce, {
        org_id: await ssoUserOrgId(jar),
      });
      if (loggedOut()) return { loggedOut: true as const, location };
    }
    expect(location.pathname).toMatch(/\/consent$/);
    const code = await approve(jar, location.searchParams.get("session")!);
    const tokens = await exchange(code, pkce.verifier);
    return { loggedOut: false as const, location, tokens };
  };

  /** The organization of the user whose SSO session the jar's cookie holds. */
  const ssoUserOrgId = async (jar: Jar) => {
    const session = await prisma.userSession.findUniqueOrThrow({
      where: { tokenHash: hashFlowToken(jar.get(userSessionCookieName())!) },
    });
    const membership = await prisma.organizationMember.findFirstOrThrow({
      where: { userId: session.userId },
    });
    return membership.organizationId;
  };

  return {
    absorb,
    cookieHeader,
    userSessionCookieName,
    newPkce,
    authorizeUrl,
    getAuthorize,
    createUser,
    approve,
    exchange,
    refresh,
    me,
    loginToCode,
    login,
    silentLogin,
    ssoUserOrgId,
  };
};
