import { BASE_URL, createTestClient, createTestUser } from "../support/auth.js";
import { LOGIN_CLIENT } from "../../definitions/index.js";
import { describe, it, expect, beforeAll } from "vitest";
import env from "../../env.js";
import {
  absorbCookies,
  browserLogin,
  cookieHeader,
  confirmLogout,
} from "../support/browserLogin.js";

/**
 * A POST that acts on the browser's cookies is refused when it comes from a
 * page that is not core, the UI or an origin of the client the cookies are
 * for: a same-site page (another port or subdomain) is sent the
 * SameSite=Lax cookies of every client.
 */

const APP_ORIGIN = "http://localhost:3000";
const REDIRECT_URI = `${APP_ORIGIN}/origin-check-callback`;
const UI_ORIGIN = new URL(env.UI_BASE_URL).origin;
const UI_REDIRECT_URI = `${env.UI_BASE_URL}/callback`;
const OTHER_ORIGIN = "http://localhost:4999";

let client: Awaited<ReturnType<typeof createTestClient>>;

const revoke = (headers: Record<string, string>) =>
  fetch(`${BASE_URL}/oauth/revoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams({ client_id: client.clientId }),
  });

const refreshCookie = () => `trt_${client.clientId}=not-a-real-token`;

beforeAll(async () => {
  client = await createTestClient({ redirectUris: [REDIRECT_URI] });
});

describe("Origin check on cookie-authenticated POSTs", () => {
  it("refuses a same-site page that is not an allowed origin", async () => {
    const res = await revoke({
      Cookie: refreshCookie(),
      "Sec-Fetch-Site": "same-site",
      Origin: OTHER_ORIGIN,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "access_denied"
    );
  });

  it("refuses a cross-site request that carries the cookies", async () => {
    const res = await revoke({
      Cookie: refreshCookie(),
      "Sec-Fetch-Site": "cross-site",
      Origin: UI_ORIGIN,
    });
    expect(res.status).toBe(403);
  });

  it("refuses a disallowed Origin when Sec-Fetch-Site is absent", async () => {
    for (const origin of [OTHER_ORIGIN, "null"]) {
      const res = await revoke({ Cookie: refreshCookie(), Origin: origin });
      expect(res.status, origin).toBe(403);
    }
  });

  it("allows same-origin, the UI, and requests with neither header", async () => {
    const allowed: Record<string, string>[] = [
      { "Sec-Fetch-Site": "same-origin" },
      { "Sec-Fetch-Site": "same-site", Origin: UI_ORIGIN },
      { Origin: UI_ORIGIN },
      {},
    ];
    for (const headers of allowed) {
      const res = await revoke({ Cookie: refreshCookie(), ...headers });
      expect(res.status, JSON.stringify(headers)).toBe(200);
    }
  });

  it("does not check a request without core's credential cookies", async () => {
    const res = await revoke({
      "Sec-Fetch-Site": "cross-site",
      Origin: OTHER_ORIGIN,
    });
    // Past the origin check to the handler, which wants a token.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_request"
    );
  });

  it("refuses a forged sign-out confirmation, and accepts the UI's", async () => {
    const user = await createTestUser();
    const { jar } = await browserLogin({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      scope: "openid",
      email: user.email,
      password: user.plainPassword,
    });
    const start = await fetch(
      `${BASE_URL}/oauth/end-session?client_id=${client.clientId}`,
      { redirect: "manual", headers: { Cookie: cookieHeader(jar) } }
    );
    absorbCookies(jar, start);
    const page = new URL(start.headers.get("location") ?? "");
    const body = JSON.stringify({
      client_id: client.clientId,
      confirm_token: page.searchParams.get("confirm_token"),
    });

    const forged = await fetch(`${BASE_URL}/oauth/end-session/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(jar),
        "Sec-Fetch-Site": "same-site",
        Origin: OTHER_ORIGIN,
      },
      body,
    });
    expect(forged.status).toBe(403);

    // The confirm page posts from the UI.
    const res = await confirmLogout(jar, start);
    expect(res.status).toBe(200);
  });

  it("refuses a login form posted from another same-site page", async () => {
    const user = await createTestUser();
    const authorize = await fetch(
      `${BASE_URL}/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: client.clientId,
        redirect_uri: REDIRECT_URI,
        state: "s",
        scope: "openid",
        code_challenge: "x".repeat(43),
        code_challenge_method: "S256",
      })}`,
      { redirect: "manual" }
    );
    const jar = new Map<string, string>();
    absorbCookies(jar, authorize);
    const res = await fetch(`${BASE_URL}/oauth/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(jar),
        "Sec-Fetch-Site": "same-site",
        Origin: OTHER_ORIGIN,
      },
      body: JSON.stringify({
        client_id: client.clientId,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        state: "s",
        scope: "openid",
        code_challenge: "x".repeat(43),
        code_challenge_method: "S256",
        email: user.email,
        password: user.plainPassword,
      }),
    });
    expect(res.status).toBe(403);
  });
});

const postForm = (
  path: string,
  body: Record<string, string>,
  headers: Record<string, string> = {}
) =>
  fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(body),
  });

/** A browser signed in to `clientId`, holding its refresh-token cookie. */
const signInWithRefreshCookie = async (
  clientId: string,
  redirectUri: string
) => {
  const user = await createTestUser();
  const { jar, code, verifier } = await browserLogin({
    clientId,
    redirectUri,
    scope: "openid",
    email: user.email,
    password: user.plainPassword,
  });
  const exchange = await postForm("/oauth/token", {
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    refresh_token_response_mode: "cookie",
  });
  expect(exchange.status).toBe(200);
  absorbCookies(jar, exchange);
  expect(jar.has(`trt_${clientId}`)).toBe(true);
  return jar;
};

const refreshByCookie = (
  clientId: string,
  jar: Map<string, string>,
  origin: string
) =>
  postForm(
    "/oauth/token",
    {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token_response_mode: "cookie",
    },
    { Cookie: cookieHeader(jar), "Sec-Fetch-Site": "same-site", Origin: origin }
  );

describe("Cookies bound to their client's origins", () => {
  it("refuses an app's page refreshing the admin UI's session by cookie", async () => {
    const jar = await signInWithRefreshCookie(
      LOGIN_CLIENT.clientId,
      UI_REDIRECT_URI
    );
    const res = await refreshByCookie(LOGIN_CLIENT.clientId, jar, APP_ORIGIN);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "access_denied"
    );
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("refuses an app's page revoking the admin UI's session by cookie", async () => {
    const jar = await signInWithRefreshCookie(
      LOGIN_CLIENT.clientId,
      UI_REDIRECT_URI
    );
    const res = await postForm(
      "/oauth/revoke",
      { client_id: LOGIN_CLIENT.clientId },
      {
        Cookie: cookieHeader(jar),
        "Sec-Fetch-Site": "same-site",
        Origin: APP_ORIGIN,
      }
    );
    expect(res.status).toBe(403);
    // Still signed in: the UI refreshes from its own origin.
    expect(
      (await refreshByCookie(LOGIN_CLIENT.clientId, jar, UI_ORIGIN)).status
    ).toBe(200);
  });

  it("lets an app's page refresh its own session by cookie", async () => {
    const jar = await signInWithRefreshCookie(client.clientId, REDIRECT_URI);
    const res = await refreshByCookie(client.clientId, jar, APP_ORIGIN);
    expect(res.status).toBe(200);
    expect(
      res.headers
        .getSetCookie()
        .some((c) => c.startsWith(`trt_${client.clientId}=`))
    ).toBe(true);
  });

  it("lets the admin UI refresh its session from its own origin", async () => {
    const jar = await signInWithRefreshCookie(
      LOGIN_CLIENT.clientId,
      UI_REDIRECT_URI
    );
    expect(
      (await refreshByCookie(LOGIN_CLIENT.clientId, jar, UI_ORIGIN)).status
    ).toBe(200);
  });

  it("does not refuse an app's request that uses none of the cookies it carries", async () => {
    const uiJar = await signInWithRefreshCookie(
      LOGIN_CLIENT.clientId,
      UI_REDIRECT_URI
    );
    // A client authenticated by its body, not by the UI's cookie the
    // browser sends along.
    const res = await postForm(
      "/oauth/token",
      {
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: "not-a-refresh-token",
      },
      {
        Cookie: cookieHeader(uiJar),
        "Sec-Fetch-Site": "same-site",
        Origin: APP_ORIGIN,
      }
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_grant"
    );
  });

  it("caps the refresh cookie at its family's remaining life", async () => {
    const jar = await signInWithRefreshCookie(client.clientId, REDIRECT_URI);
    const res = await refreshByCookie(client.clientId, jar, APP_ORIGIN);
    const cookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith(`trt_${client.clientId}=`));
    const maxAge = Number(/Max-Age=(\d+)/i.exec(cookie ?? "")?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(env.JWT_REFRESH_TOKEN_TTL);
  });

  it("answers a cookie cookie-parser reads as JSON like a missing one", async () => {
    const res = await revoke({
      Cookie: `trt_${client.clientId}=${encodeURIComponent('j:{"a":1}')}`,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_request"
    );
  });
});

describe("Credentialed CORS", () => {
  const corsOrigin = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${BASE_URL}${path}`, {
      redirect: "manual",
      ...init,
      headers: { Origin: UI_ORIGIN, ...(init.headers ?? {}) },
    });
    return res.headers.get("access-control-allow-origin");
  };

  it("answers the API and the token endpoint", async () => {
    expect(await corsOrigin("/health")).toBe(UI_ORIGIN);
    expect(
      await corsOrigin("/oauth/token", {
        method: "OPTIONS",
        headers: { "Access-Control-Request-Method": "POST" },
      })
    ).toBe(UI_ORIGIN);
  });

  it("leaves out GET /oauth/authorize and the admin UI's pages", async () => {
    expect(await corsOrigin("/oauth/authorize?client_id=x")).toBeNull();
    expect(await corsOrigin("/OAuth/Authorize/?client_id=x")).toBeNull();
    expect(await corsOrigin("/")).toBeNull();
    expect(await corsOrigin("/callback?code=x")).toBeNull();
  });
});
