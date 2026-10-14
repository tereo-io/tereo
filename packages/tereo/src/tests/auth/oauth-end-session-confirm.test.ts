import { describe, it, expect, beforeAll } from "vitest";
import { hashFlowToken } from "../../utils/crypto.js";
import { prisma } from "../../utils/db/prisma.js";
import {
  absorbCookies,
  browserLogin,
  confirmLogout,
  cookieHeader,
  userSessionCookieName,
  type CookieJar,
} from "../utils/browserLogin.js";
import {
  BASE_URL,
  createTestClient,
  createTestUser,
} from "./utils/test-helpers.js";

/**
 * End-session without an id_token_hint: anything can send a browser there,
 * so it only asks the user to confirm. The session ends on the confirm POST,
 * and only with the token core put in this browser's cookie.
 */

const REDIRECT_URI = "http://localhost:3000/end-session-confirm-callback";
const POST_LOGOUT_URI = "http://localhost:3000/end-session-confirm-logout";
const CONFIRM_COOKIE = "tereo_logout_confirm";

let client: Awaited<ReturnType<typeof createTestClient>>;

const signIn = async () => {
  const user = await createTestUser();
  const { jar } = await browserLogin({
    clientId: client.clientId,
    redirectUri: REDIRECT_URI,
    scope: "openid",
    email: user.email,
    password: user.plainPassword,
  });
  return { user, jar };
};

const sessionsOf = (userId: string) =>
  prisma.userSession.count({ where: { userId } });

/** A cross-site GET: the browser's cookies, no hint. */
const endSessionGet = (jar: CookieJar, params: Record<string, string>) =>
  fetch(`${BASE_URL}/oauth/end-session?${new URLSearchParams(params)}`, {
    redirect: "manual",
    headers: { Cookie: cookieHeader(jar) },
  });

const postConfirm = (jar: CookieJar, body: Record<string, string>) =>
  fetch(`${BASE_URL}/oauth/end-session/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  client = await createTestClient({
    redirectUris: [REDIRECT_URI],
    postLogoutRedirectUris: [POST_LOGOUT_URI],
  });
});

describe("end-session without id_token_hint", () => {
  it("does not end the session on a GET; it sends the browser to confirm", async () => {
    const { user, jar } = await signIn();
    const ssoCookie = jar.get(userSessionCookieName(client.clientId));

    const res = await endSessionGet(jar, { client_id: client.clientId });
    expect(res.status).toBe(302);
    const page = new URL(res.headers.get("location") ?? "");
    expect(page.pathname).toMatch(/\/logout$/);
    expect(page.searchParams.get("client_id")).toBe(client.clientId);

    // Nothing ended and no session cookie cleared: only the confirm cookie set.
    expect(await sessionsOf(user.id)).toBe(1);
    const setCookies = res.headers.getSetCookie();
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0]).toMatch(
      new RegExp(`^${CONFIRM_COOKIE}_${client.clientId}=`)
    );
    absorbCookies(jar, res);
    expect(jar.get(userSessionCookieName(client.clientId))).toBe(ssoCookie);
  });

  it("does not end the session on a POST either", async () => {
    const { user, jar } = await signIn();

    const res = await fetch(`${BASE_URL}/oauth/end-session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader(jar),
      },
      body: new URLSearchParams({ client_id: client.clientId }),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(await sessionsOf(user.id)).toBe(1);
  });

  it("ends this browser's session once the user confirms", async () => {
    const { user, jar } = await signIn();
    const other = await browserLogin({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      scope: "openid",
      email: user.email,
      password: user.plainPassword,
    });
    expect(await sessionsOf(user.id)).toBe(2);

    const res = await confirmLogout(
      jar,
      await endSessionGet(jar, {
        client_id: client.clientId,
        post_logout_redirect_uri: POST_LOGOUT_URI,
        state: "bye",
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      redirect_url: string;
      sign_in_url: string;
    };
    expect(body.redirect_url).toBe(`${POST_LOGOUT_URI}?state=bye`);
    expect(body.sign_in_url).toBe("http://localhost:3000/");

    expect(jar.has(userSessionCookieName(client.clientId))).toBe(false);
    expect(jar.has(`${CONFIRM_COOKIE}_${client.clientId}`)).toBe(false);
    // The other browser's session survives.
    const remaining = await prisma.userSession.findMany({
      where: { userId: user.id },
    });
    expect(remaining.map((s) => s.tokenHash)).toEqual([
      hashFlowToken(other.jar.get(userSessionCookieName(client.clientId))!),
    ]);
  });

  it("shows the confirm page the client's name, given the browser's token", async () => {
    const { jar } = await signIn();
    const res = await endSessionGet(jar, { client_id: client.clientId });
    absorbCookies(jar, res);
    const page = new URL(res.headers.get("location") ?? "");

    const details = await fetch(
      `${BASE_URL}/oauth/end-session/confirm?${new URLSearchParams({
        client_id: client.clientId,
        confirm_token: page.searchParams.get("confirm_token")!,
      })}`,
      { headers: { Cookie: cookieHeader(jar) } }
    );
    expect(details.status).toBe(200);
    expect(await details.json()).toEqual({
      client_name: client.name,
      sign_in_url: "http://localhost:3000/",
    });
  });

  it("refuses a confirm without the cookie's token", async () => {
    const { user, jar } = await signIn();
    const res = await endSessionGet(jar, { client_id: client.clientId });
    absorbCookies(jar, res);
    const token = new URL(res.headers.get("location") ?? "").searchParams.get(
      "confirm_token"
    )!;

    // A wrong token, with the cookie.
    const wrong = await postConfirm(jar, {
      client_id: client.clientId,
      confirm_token: `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`,
    });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe(
      "invalid_session"
    );

    // The right token, from a browser that was never given the cookie: what
    // a cross-site form post that learned the URL would look like.
    const withoutCookie = new Map(jar);
    withoutCookie.delete(`${CONFIRM_COOKIE}_${client.clientId}`);
    const stolen = await postConfirm(withoutCookie, {
      client_id: client.clientId,
      confirm_token: token,
    });
    expect(stolen.status).toBe(400);

    // The details lookup is refused the same way.
    const details = await fetch(
      `${BASE_URL}/oauth/end-session/confirm?${new URLSearchParams({
        client_id: client.clientId,
        confirm_token: "not-the-token",
      })}`,
      { headers: { Cookie: cookieHeader(jar) } }
    );
    expect(details.status).toBe(400);

    expect(await sessionsOf(user.id)).toBe(1);
  });

  it("accepts a confirm token only once", async () => {
    const { jar } = await signIn();
    const res = await endSessionGet(jar, { client_id: client.clientId });
    const token = new URL(res.headers.get("location") ?? "").searchParams.get(
      "confirm_token"
    )!;
    const first = await confirmLogout(jar, res);
    expect(first.status).toBe(200);

    const again = await postConfirm(jar, {
      client_id: client.clientId,
      confirm_token: token,
    });
    expect(again.status).toBe(400);
  });

  it("refuses an unregistered post_logout_redirect_uri at confirm", async () => {
    const { user, jar } = await signIn();
    const res = await endSessionGet(jar, { client_id: client.clientId });
    absorbCookies(jar, res);
    const token = new URL(res.headers.get("location") ?? "").searchParams.get(
      "confirm_token"
    )!;

    const confirm = await postConfirm(jar, {
      client_id: client.clientId,
      confirm_token: token,
      post_logout_redirect_uri: "https://evil.example/landing",
    });
    expect(confirm.status).toBe(400);
    expect(await sessionsOf(user.id)).toBe(1);
  });

  it("still ends the session at once with a valid id_token_hint", async () => {
    const user = await createTestUser();
    const { jar, code, verifier } = await browserLogin({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      scope: "openid",
      email: user.email,
      password: user.plainPassword,
    });
    const tokens = await fetch(`${BASE_URL}/oauth/token`, {
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
    const { id_token } = (await tokens.json()) as { id_token: string };

    const res = await endSessionGet(jar, {
      id_token_hint: id_token,
      post_logout_redirect_uri: POST_LOGOUT_URI,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(POST_LOGOUT_URI);
    expect(await sessionsOf(user.id)).toBe(0);
  });

  it("asks to confirm when the hint names someone other than the browser's user", async () => {
    // Any site can sign its own user in and hold their ID token for the
    // client; sent with a victim's browser, it must not sign the victim out.
    const { user: victim, jar } = await signIn();
    const ssoCookie = jar.get(userSessionCookieName(client.clientId));
    const attacker = await createTestUser();
    const login = await browserLogin({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      scope: "openid",
      email: attacker.email,
      password: attacker.plainPassword,
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
    const { id_token } = (await tokens.json()) as { id_token: string };

    const res = await endSessionGet(jar, {
      id_token_hint: id_token,
      post_logout_redirect_uri: POST_LOGOUT_URI,
    });
    expect(res.status).toBe(302);
    const page = new URL(res.headers.get("location") ?? "");
    expect(page.pathname).toMatch(/\/logout$/);
    expect(page.searchParams.get("confirm_token")).toBeTruthy();

    // Nothing ended, and only the confirm cookie set.
    expect(await sessionsOf(victim.id)).toBe(1);
    expect(await sessionsOf(attacker.id)).toBe(1);
    const setCookies = res.headers.getSetCookie();
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0]).toMatch(
      new RegExp(`^${CONFIRM_COOKIE}_${client.clientId}=`)
    );
    absorbCookies(jar, res);
    expect(jar.get(userSessionCookieName(client.clientId))).toBe(ssoCookie);

    // The victim can still sign out by confirming.
    const confirmed = await confirmLogout(jar, res);
    expect(confirmed.status).toBe(200);
    expect(await sessionsOf(victim.id)).toBe(0);
  });
});
