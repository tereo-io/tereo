import { createHash, randomBytes } from "crypto";
import { BASE_URL } from "./auth.js";
import { expect } from "vitest";

/**
 * The browser side of the authorize flow, for tests that need the cookies it
 * leaves behind: a cookie jar, and a password login through
 * authorize → login → consent that fills it.
 */

export type CookieJar = Map<string, string>;

/** Applies a response's Set-Cookie headers to the jar, honouring clears. */
export const absorbCookies = (jar: CookieJar, res: Response) => {
  for (const cookie of res.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!value || /expires=Thu, 01 Jan 1970/i.test(cookie)) jar.delete(name);
    else jar.set(name, value);
  }
};

export const cookieHeader = (jar: CookieJar) =>
  [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

/** The SSO cookie; set at consent, scoped to one client. */
export const userSessionCookieName = (clientId: string) =>
  `tereo_user_session_${clientId}`;

const base64url = (buf: Buffer) => buf.toString("base64url");

export const newPkce = () => {
  const verifier = base64url(randomBytes(32));
  return {
    verifier,
    challenge: base64url(createHash("sha256").update(verifier).digest()),
    state: randomBytes(16).toString("hex"),
  };
};

export interface BrowserLoginOptions {
  clientId: string;
  redirectUri: string;
  scope: string;
  email: string;
  password: string;
  /** Sent with the authorize request, to come back in the ID token. */
  nonce?: string;
  jar?: CookieJar;
}

/**
 * Password login through to a code: approved consent, or none for a client
 * that skips it. Returns the authorization code and its verifier; the jar
 * ends holding the SSO cookie.
 */
export const browserLogin = async ({
  clientId,
  redirectUri,
  scope,
  email,
  password,
  nonce,
  jar = new Map(),
}: BrowserLoginOptions) => {
  const pkce = newPkce();
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state: pkce.state,
    scope,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    ...(nonce && { nonce }),
  };

  const start = await fetch(
    `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
    { redirect: "manual", headers: { Cookie: cookieHeader(jar) } }
  );
  absorbCookies(jar, start);
  expect(start.status).toBe(302);
  expect(new URL(start.headers.get("location") ?? "").pathname).toMatch(
    /\/login$/
  );

  const submit = await fetch(`${BASE_URL}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify({ ...params, email, password }),
  });
  absorbCookies(jar, submit);
  expect(submit.status).toBe(200);
  const { redirect_url } = (await submit.json()) as { redirect_url: string };
  const afterLogin = new URL(redirect_url).searchParams;
  if (afterLogin.has("code")) {
    return {
      jar,
      code: afterLogin.get("code")!,
      verifier: pkce.verifier,
      redirectUrl: redirect_url,
    };
  }
  const session = afterLogin.get("session");
  expect(session).toBeTruthy();

  const consent = await fetch(`${BASE_URL}/oauth/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify({ session_token: session, approved: true }),
  });
  absorbCookies(jar, consent);
  expect(consent.status).toBe(200);
  const approved = (await consent.json()) as { redirect_url: string };
  const code = new URL(approved.redirect_url).searchParams.get("code");
  expect(code).toBeTruthy();

  return {
    jar,
    code: code!,
    verifier: pkce.verifier,
    redirectUrl: approved.redirect_url,
  };
};

/**
 * Takes end-session's redirect to the UI's sign-out confirmation and does
 * what that page does when the user confirms: posts the confirm token back
 * with the browser's cookies. Returns the confirm response.
 */
export const confirmLogout = async (jar: CookieJar, endSession: Response) => {
  absorbCookies(jar, endSession);
  expect(endSession.status).toBe(302);
  const page = new URL(endSession.headers.get("location") ?? "");
  expect(page.pathname).toMatch(/\/logout$/);

  const body: Record<string, string> = {};
  for (const key of [
    "client_id",
    "confirm_token",
    "post_logout_redirect_uri",
    "state",
  ]) {
    const value = page.searchParams.get(key);
    if (value) body[key] = value;
  }

  const res = await fetch(`${BASE_URL}/oauth/end-session/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify(body),
  });
  absorbCookies(jar, res);
  return res;
};
