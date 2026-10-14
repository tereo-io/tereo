import { describe, it, expect, beforeAll } from "vitest";
import env from "../../env.js";
import {
  absorbCookies,
  browserLogin,
  cookieHeader,
  confirmLogout,
} from "../utils/browserLogin.js";
import {
  BASE_URL,
  createTestClient,
  createTestUser,
} from "./utils/test-helpers.js";

/**
 * A POST that acts on the browser's cookies is refused when it comes from a
 * page that is not core, the UI or an allowed origin: a same-site page
 * (another port or subdomain) is sent the SameSite=Lax cookies too.
 */

const REDIRECT_URI = "http://localhost:3000/origin-check-callback";
const UI_ORIGIN = new URL(env.UI_BASE_URL).origin;
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
