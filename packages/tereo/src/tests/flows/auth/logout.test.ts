// @module-tag int
// @module-tag auth
import { ensureTestOrganization } from "../../support/principals.js";
import { createTestClient } from "../../support/auth/clients.js";
import { confirmLogout } from "../../support/browserLogin.js";
import { makeServiceOf } from "../../support/testService.js";
import { createTestUser } from "../../support/auth/users.js";
import { BASE_URL } from "../../support/auth/constants.js";
import { describe, it, expect, beforeAll } from "vitest";
import { hashFlowToken } from "../../../utils/crypto.js";
import { decodeJwt } from "../../support/auth/tokens.js";
import { prisma } from "../../../utils/db/prisma.js";
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateUniqueId,
} from "../../support/auth/crypto.js";
import {
  ID_TOKEN_HINT_GRACE_SECONDS,
  generateIdToken,
} from "../../../utils/tokens.js";

const REDIRECT_URI = "http://localhost:3000/session-lifecycle-callback";
const POST_LOGOUT_URI = "http://localhost:3000/session-lifecycle-logout";
// The tests call /account and /admin with these tokens.
const SCOPE = "openid profile email offline_access core:account core:admin";

type Jar = Map<string, string>;

interface TokenSet {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in: number;
}

interface TestUser {
  id: string;
  email: string;
  password: string;
  orgId: string;
}

let client: Awaited<ReturnType<typeof createTestClient>>;
let introspector: Awaited<ReturnType<typeof createTestClient>>;

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

const userSessionCookieName = () => `tereo_user_session_${client.clientId}`;

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
    client_id: client.clientId,
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
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
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
      client_id: client.clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  return { status: res.status, body: (await res.json()) as TokenSet & Err };
};

interface Err {
  error?: string;
  error_description?: string;
}

const refresh = async (refreshToken: string) => {
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: client.clientId,
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
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify({
      email: user.email,
      password: user.password,
      client_id: client.clientId,
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

const userSessionRows = (userId: string) =>
  prisma.userSession.findMany({ where: { userId } });

beforeAll(async () => {
  // A service in the login client's audience introspects its tokens.
  introspector = await createTestClient({ clientType: "confidential" });
  client = await createTestClient({
    redirectUris: [REDIRECT_URI],
    postLogoutRedirectUris: [POST_LOGOUT_URI],
    audience: [await makeServiceOf(introspector.id)],
  });
});

describe("Session lifecycle", () => {
  describe("logout (/oauth/end-session)", () => {
    const expectFullyLoggedOut = async (
      user: TestUser,
      jar: Jar,
      tokens: TokenSet
    ) => {
      expect((await refresh(tokens.refresh_token)).status).toBe(400);
      const access = await me(tokens.access_token);
      expect(access.status).toBe(401);
      expect(access.body.error).toBe("invalid_token");
      expect(await userSessionRows(user.id)).toHaveLength(0);
      expect((await silentLogin(jar)).loggedOut).toBe(true);
      expect((await silentLogin(jar, { org_id: user.orgId })).loggedOut).toBe(
        true
      );
    };

    it("with id_token_hint: revokes tokens and the SSO session at once", async () => {
      const user = await createUser();
      const { jar, tokens } = await login(user);
      const ssoCookie = jar.get(userSessionCookieName());

      const url = new URL(`${BASE_URL}/oauth/end-session`);
      url.searchParams.set("id_token_hint", tokens.id_token!);
      url.searchParams.set("post_logout_redirect_uri", POST_LOGOUT_URI);
      const res = await fetch(url, {
        redirect: "manual",
        headers: { Cookie: cookieHeader(jar) },
      });
      expect(res.status).toBe(302);
      absorb(jar, res);
      expect(jar.has(userSessionCookieName())).toBe(false);

      // A browser that ignored the cleared cookie still gets nothing.
      jar.set(userSessionCookieName(), ssoCookie!);
      await expectFullyLoggedOut(user, jar, tokens);
    });

    it("with client_id and the SSO cookie only: same outcome once the user confirms", async () => {
      const user = await createUser();
      const { jar, tokens } = await login(user);
      const ssoCookie = jar.get(userSessionCookieName());

      const res = await fetch(`${BASE_URL}/oauth/end-session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader(jar),
        },
        body: JSON.stringify({ client_id: client.clientId }),
        redirect: "manual",
      });
      expect((await confirmLogout(jar, res)).status).toBe(200);

      jar.set(userSessionCookieName(), ssoCookie!);
      await expectFullyLoggedOut(user, jar, tokens);
    });

    /** The admin UI's call: a form post with its cookies, client_id and hint. */
    const endSession = async (
      jar: Jar,
      params: Record<string, string> = {}
    ) => {
      const res = await fetch(`${BASE_URL}/oauth/end-session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookieHeader(jar),
        },
        body: new URLSearchParams(params),
        redirect: "manual",
      });
      absorb(jar, res);
      return res;
    };

    const revokeRefresh = (refreshToken: string) =>
      fetch(`${BASE_URL}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.clientId,
          token: refreshToken,
        }),
      });

    const expectStillSignedIn = async (browser: {
      jar: Jar;
      tokens: TokenSet;
    }) => {
      expect((await me(browser.tokens.access_token)).status).toBe(200);
      expect((await refresh(browser.tokens.refresh_token)).status).toBe(200);
      const silent = await silentLogin(browser.jar);
      expect(silent.loggedOut).toBe(false);
      if (!silent.loggedOut) expect(silent.tokens.status).toBe(200);
    };

    const expectBrowserLoggedOut = async (
      user: TestUser,
      browser: { jar: Jar; tokens: TokenSet },
      ssoCookie: string
    ) => {
      expect((await refresh(browser.tokens.refresh_token)).status).toBe(400);
      expect((await me(browser.tokens.access_token)).status).toBe(401);
      // Even a browser that ignored the cleared cookie gets nothing.
      browser.jar.set(userSessionCookieName(), ssoCookie);
      expect((await silentLogin(browser.jar)).loggedOut).toBe(true);
      expect(
        (await silentLogin(browser.jar, { org_id: user.orgId })).loggedOut
      ).toBe(true);
    };

    it("logs out only this browser: another browser stays signed in", async () => {
      const user = await createUser();
      const laptop = await login(user);
      const phone = await login(user);
      const laptopSso = laptop.jar.get(userSessionCookieName())!;

      const res = await endSession(laptop.jar, {
        client_id: client.clientId,
        id_token_hint: laptop.tokens.id_token!,
      });
      expect(res.status).toBe(200);
      expect(laptop.jar.has(userSessionCookieName())).toBe(false);

      await expectBrowserLoggedOut(user, laptop, laptopSso);
      await expectStillSignedIn(phone);
    });

    it("with only the hint (no cookies): its sid names the browser", async () => {
      const user = await createUser();
      const laptop = await login(user);
      const phone = await login(user);
      const laptopSso = laptop.jar.get(userSessionCookieName())!;

      const res = await endSession(new Map(), {
        id_token_hint: laptop.tokens.id_token!,
      });
      expect(res.status).toBe(200);

      await expectBrowserLoggedOut(user, laptop, laptopSso);
      await expectStillSignedIn(phone);
    });

    it("revokes every token family the browser obtained, silent logins included", async () => {
      const user = await createUser();
      const laptop = await login(user);
      const laptopSso = laptop.jar.get(userSessionCookieName())!;
      const silent = await silentLogin(laptop.jar, { org_id: user.orgId });
      expect(silent.loggedOut).toBe(false);
      if (silent.loggedOut) return;
      expect(silent.tokens.status).toBe(200);

      const confirmed = await confirmLogout(
        laptop.jar,
        await endSession(laptop.jar, { client_id: client.clientId })
      );
      expect(confirmed.status).toBe(200);

      expect((await refresh(silent.tokens.body.refresh_token)).status).toBe(
        400
      );
      await expectBrowserLoggedOut(user, laptop, laptopSso);
    });

    it(
      "works after /oauth/revoke already revoked the refresh token (the UI's race)",
      { tags: ["race"] },
      async () => {
        const user = await createUser();
        const laptop = await login(user);
        const phone = await login(user);
        const laptopSso = laptop.jar.get(userSessionCookieName())!;

        expect((await revokeRefresh(laptop.tokens.refresh_token)).status).toBe(
          200
        );
        const res = await endSession(laptop.jar, {
          client_id: client.clientId,
          id_token_hint: laptop.tokens.id_token!,
        });
        expect(res.status).toBe(200);

        await expectBrowserLoggedOut(user, laptop, laptopSso);
        await expectStillSignedIn(phone);
      }
    );

    it("works before /oauth/revoke, which then still succeeds", async () => {
      const user = await createUser();
      const laptop = await login(user);
      const phone = await login(user);
      const laptopSso = laptop.jar.get(userSessionCookieName())!;

      const res = await endSession(laptop.jar, {
        client_id: client.clientId,
        id_token_hint: laptop.tokens.id_token!,
      });
      expect(res.status).toBe(200);
      expect((await revokeRefresh(laptop.tokens.refresh_token)).status).toBe(
        200
      );

      await expectBrowserLoggedOut(user, laptop, laptopSso);
      await expectStillSignedIn(phone);
    });

    it("with nothing that identifies a browser, revokes nothing", async () => {
      const user = await createUser();
      const laptop = await login(user);

      const jar: Jar = new Map();
      const res = await confirmLogout(
        jar,
        await endSession(jar, { client_id: client.clientId })
      );
      expect(res.status).toBe(200);
      expect(
        ((await res.json()) as { redirect_url: unknown }).redirect_url
      ).toBe(null);

      await expectStillSignedIn(laptop);
    });

    it("asks to confirm for a hint expired past the grace period", async () => {
      const user = await createUser();
      const laptop = await login(user);
      const { sid } = decodeJwt(laptop.tokens.id_token!) as { sid?: string };
      expect(sid).toBeTruthy();
      const stale = generateIdToken({
        subject: user.id,
        clientId: client.clientId,
        sessionId: sid,
        expiresIn: -(ID_TOKEN_HINT_GRACE_SECONDS + 60),
      }).token;

      const res = await endSession(new Map(), { id_token_hint: stale });
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get("location") ?? "").pathname).toMatch(
        /\/logout$/
      );
      await expectStillSignedIn(laptop);
    });

    it("accepts a hint expired within the grace period", async () => {
      const user = await createUser();
      const laptop = await login(user);
      const laptopSso = laptop.jar.get(userSessionCookieName())!;
      const { sid } = decodeJwt(laptop.tokens.id_token!) as { sid?: string };
      const lapsed = generateIdToken({
        subject: user.id,
        clientId: client.clientId,
        sessionId: sid,
        expiresIn: -60,
      }).token;

      const res = await endSession(new Map(), { id_token_hint: lapsed });
      expect(res.status).toBe(200);
      await expectBrowserLoggedOut(user, laptop, laptopSso);
    });

    it("answers 400 invalid_request with neither client_id nor id_token_hint", async () => {
      const res = await endSession(new Map());
      expect(res.status).toBe(400);
      expect(((await res.json()) as Err).error).toBe("invalid_request");
    });
  });

  describe("admin UI logout (/oauth/revoke with the refresh cookie)", () => {
    it("revokes the refresh token and its access tokens", async () => {
      const user = await createUser();
      const { tokens } = await login(user);
      const res = await fetch(`${BASE_URL}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.clientId,
          token: tokens.refresh_token,
          token_type_hint: "refresh_token",
        }),
      });
      expect(res.status).toBe(200);
      expect((await refresh(tokens.refresh_token)).status).toBe(400);
      expect((await me(tokens.access_token)).status).toBe(401);
    });

    it("leaves no way back in without a password", async () => {
      const user = await createUser();
      const { jar, tokens } = await login(user);
      await fetch(`${BASE_URL}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.clientId,
          token: tokens.refresh_token,
        }),
      });
      const result = await silentLogin(jar, { org_id: user.orgId });
      expect(result.loggedOut).toBe(true);
    });
  });
});
