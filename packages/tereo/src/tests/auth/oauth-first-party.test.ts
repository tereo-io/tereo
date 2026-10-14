import { ensureTestOrganization } from "../utils/principals.js";
import { LOGIN_CLIENT } from "../../definitions/index.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import {
  absorbCookies,
  browserLogin,
  cookieHeader,
  newPkce,
  type CookieJar,
} from "../utils/browserLogin.js";
import {
  BASE_URL,
  createTestClient,
  createTestUser,
} from "./utils/test-helpers.js";

/**
 * Which client a login flow belongs to, beyond its first step:
 * - a silent (`prompt=none`) authorize for core's own login client issues
 *   its code straight away; any other client gets consent_required, since
 *   the consent screen cannot be shown;
 * - the UI's login-flow pages carry the authorize request, so "Back to sign
 *   in" restarts it for the client that began the login;
 * - after a confirmed sign-out, the way back is that client's own app.
 */

const THIRD_PARTY_REDIRECT = "http://localhost:3100/first-party-test/callback";

let thirdParty: Awaited<ReturnType<typeof createTestClient>>;
let loginRedirectUri = "";

const authorize = (
  jar: CookieJar,
  clientId: string,
  redirectUri: string,
  extra: Record<string, string> = {}
) => {
  const pkce = newPkce();
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state: pkce.state,
    scope: "openid",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    ...extra,
  };
  return {
    pkce,
    params,
    response: fetch(
      `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
      { redirect: "manual", headers: { Cookie: cookieHeader(jar) } }
    ),
  };
};

const signIn = async (clientId: string, redirectUri: string) => {
  const user = await createTestUser();
  const { jar } = await browserLogin({
    clientId,
    redirectUri,
    scope: "openid",
    email: user.email,
    password: user.plainPassword,
  });
  return { user, jar };
};

beforeAll(async () => {
  thirdParty = await createTestClient({
    redirectUris: [THIRD_PARTY_REDIRECT],
  });
  const loginClient = await prisma.oAuthClient.findFirstOrThrow({
    where: { clientId: LOGIN_CLIENT.clientId },
  });
  loginRedirectUri = loginClient.redirectUris[0];
});

describe("prompt=none consent", () => {
  it("issues the code at once for core's own login client", async () => {
    const { user, jar } = await signIn(LOGIN_CLIENT.clientId, loginRedirectUri);

    const { pkce, response } = authorize(
      jar,
      LOGIN_CLIENT.clientId,
      loginRedirectUri,
      { prompt: "none" }
    );
    const res = await response;
    absorbCookies(jar, res);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(loginRedirectUri);
    expect(location.searchParams.get("state")).toBe(pkce.state);
    expect(location.searchParams.get("error")).toBeNull();
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokens = await fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: LOGIN_CLIENT.clientId,
        code: code!,
        redirect_uri: loginRedirectUri,
        code_verifier: pkce.verifier,
      }),
    });
    expect(tokens.status).toBe(200);

    // The browser's SSO session is continued, not duplicated.
    expect(await prisma.userSession.count({ where: { userId: user.id } })).toBe(
      1
    );
    expect(
      await prisma.consentSession.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("answers a third-party client consent_required, since it cannot show consent", async () => {
    const { jar, user } = await signIn(
      thirdParty.clientId,
      THIRD_PARTY_REDIRECT
    );
    const before = await prisma.consentSession.count({
      where: { userId: user.id },
    });

    const { response, params } = authorize(
      jar,
      thirdParty.clientId,
      THIRD_PARTY_REDIRECT,
      { prompt: "none" }
    );
    const res = await response;
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(THIRD_PARTY_REDIRECT);
    expect(location.searchParams.get("error")).toBe("consent_required");
    expect(location.searchParams.get("state")).toBe(params.state);
    expect(location.searchParams.get("code")).toBeNull();
    expect(
      await prisma.consentSession.count({ where: { userId: user.id } })
    ).toBe(before);
  });
});

describe("org_id switch consent", () => {
  const joinOrg = async (userId: string) => {
    const orgId = await ensureTestOrganization(`first-party-switch-${userId}`);
    await prisma.organizationMember.create({
      data: { organizationId: orgId, userId },
    });
    return orgId;
  };

  it("issues the code at once for core's own login client", async () => {
    const { user, jar } = await signIn(LOGIN_CLIENT.clientId, loginRedirectUri);
    const orgId = await joinOrg(user.id);

    const { pkce, response } = authorize(
      jar,
      LOGIN_CLIENT.clientId,
      loginRedirectUri,
      { org_id: orgId }
    );
    const res = await response;
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(loginRedirectUri);
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokens = await fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: LOGIN_CLIENT.clientId,
        code: code!,
        redirect_uri: loginRedirectUri,
        code_verifier: pkce.verifier,
      }),
    });
    expect(tokens.status).toBe(200);
    const { access_token } = (await tokens.json()) as { access_token: string };
    const payload = JSON.parse(
      Buffer.from(access_token.split(".")[1], "base64url").toString()
    ) as { org_id?: string };
    expect(payload.org_id).toBe(orgId);
    expect(
      await prisma.consentSession.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("still shows a third-party client the consent screen", async () => {
    const { user, jar } = await signIn(
      thirdParty.clientId,
      THIRD_PARTY_REDIRECT
    );
    const orgId = await joinOrg(user.id);

    const { response } = authorize(
      jar,
      thirdParty.clientId,
      THIRD_PARTY_REDIRECT,
      { org_id: orgId }
    );
    const res = await response;
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toMatch(/\/consent$/);
    expect(location.searchParams.get("code")).toBeNull();
  });
});

describe("back to sign in", () => {
  it("gives the consent page the third-party client's authorize request, which restarts its login", async () => {
    const { jar, user } = await signIn(
      thirdParty.clientId,
      THIRD_PARTY_REDIRECT
    );
    // An org switch: the silent path that shows a third-party client consent.
    const orgId = await ensureTestOrganization(`back-to-sign-in-${user.id}`);
    await prisma.organizationMember.create({
      data: { organizationId: orgId, userId: user.id },
    });

    const { params, response } = authorize(
      jar,
      thirdParty.clientId,
      THIRD_PARTY_REDIRECT,
      { org_id: orgId }
    );
    const consent = new URL((await response).headers.get("location") ?? "");
    expect(consent.pathname).toMatch(/\/consent$/);
    // All but org_id, which a restarted sign-in does not repeat.
    const restartable = Object.entries(params).filter(([k]) => k !== "org_id");
    for (const [key, value] of restartable) {
      expect(consent.searchParams.get(key), key).toBe(value);
    }
    expect(consent.searchParams.get("org_id")).toBeNull();

    // What "Back to sign in" does with them.
    const restart = new URLSearchParams(consent.searchParams);
    restart.delete("session");
    const res = await fetch(`${BASE_URL}/oauth/authorize?${restart}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const login = new URL(res.headers.get("location") ?? "");
    expect(login.pathname).toMatch(/\/login$/);
    expect(login.searchParams.get("client_id")).toBe(thirdParty.clientId);
    expect(login.searchParams.get("redirect_uri")).toBe(THIRD_PARTY_REDIRECT);
    expect(login.searchParams.get("state")).toBe(params.state);
  });

  it("gives the org picker the client's authorize request", async () => {
    const user = await createTestUser();
    for (const label of ["first-party-a", "first-party-b"]) {
      const orgId = await ensureTestOrganization(`${label}-${user.id}`);
      await prisma.organizationMember.create({
        data: { organizationId: orgId, userId: user.id },
      });
    }
    const jar: CookieJar = new Map();
    const { params, response } = authorize(
      jar,
      thirdParty.clientId,
      THIRD_PARTY_REDIRECT
    );
    absorbCookies(jar, await response);

    const submit = await fetch(`${BASE_URL}/oauth/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({
        ...params,
        email: user.email,
        password: user.plainPassword,
      }),
    });
    expect(submit.status).toBe(200);
    const { redirect_url } = (await submit.json()) as { redirect_url: string };
    const picker = new URL(redirect_url);
    expect(picker.pathname).toMatch(/\/login\/org-select$/);
    expect(picker.searchParams.get("session")).toBeTruthy();
    for (const [key, value] of Object.entries(params)) {
      expect(picker.searchParams.get(key), key).toBe(value);
    }
  });

  it("after signing out, points back to the client's own app, or the admin UI for core's client", async () => {
    const signInUrlFor = async (clientId: string) => {
      const jar: CookieJar = new Map();
      const res = await fetch(
        `${BASE_URL}/oauth/end-session?client_id=${clientId}`,
        { redirect: "manual" }
      );
      absorbCookies(jar, res);
      const page = new URL(res.headers.get("location") ?? "");
      const details = await fetch(
        `${BASE_URL}/oauth/end-session/confirm?${new URLSearchParams({
          client_id: clientId,
          confirm_token: page.searchParams.get("confirm_token")!,
        })}`,
        { headers: { Cookie: cookieHeader(jar) } }
      );
      expect(details.status).toBe(200);
      return ((await details.json()) as { sign_in_url: string }).sign_in_url;
    };

    expect(await signInUrlFor(thirdParty.clientId)).toBe(
      "http://localhost:3100/"
    );
    expect(await signInUrlFor(LOGIN_CLIENT.clientId)).toBe(
      loginRedirectUri.replace(/callback$/, "")
    );
  });
});
