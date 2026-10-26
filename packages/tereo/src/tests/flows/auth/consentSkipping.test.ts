// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../../utils/defaultOrganization.js";
import { generateTotpSecret, encryptTotpSecret } from "../../../utils/totp.js";
import { createAdminUser, createTestUser } from "../../support/auth/users.js";
import { applyProvisioning } from "../../../utils/provisioning/index.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { removeLoginClients } from "../../support/provisioning.js";
import { createTestClient } from "../../support/auth/clients.js";
import { generateTotpCode } from "../../support/auth/crypto.js";
import { LOGIN_CLIENT } from "../../../definitions/index.js";
import { BASE_URL } from "../../support/auth/constants.js";
import { prisma } from "../../../utils/db/prisma.js";
import { randomBytes } from "node:crypto";
import {
  absorbCookies,
  browserLogin,
  cookieHeader,
  newPkce,
  type CookieJar,
} from "../../support/browserLogin.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../support/principals.js";

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

const SKIPPING_REDIRECT = "http://localhost:3100/skips-consent/callback";

let thirdParty: Awaited<ReturnType<typeof createTestClient>>;
let skipping: { id: string; clientId: string };
let skippingCore: { id: string; clientId: string };
let loginRedirectUri = "";

const createSkippingClient = async (scopes: string[] = ["openid"]) => {
  const token = await getTestPrincipalToken({ permissions: ["clients.write"] });
  const res = await fetch(`${BASE_URL}/v1/admin/clients`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "Skips consent",
      clientType: "public",
      redirectUris: [SKIPPING_REDIRECT],
      scopes,
      grantTypes: ["authorization_code", "refresh_token"],
      consentRequired: false,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; clientId: string };
};

const exchange = (
  clientId: string,
  redirectUri: string,
  code: string,
  verifier: string
) =>
  fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });

/** A password login up to the first answer after it, consent not posted. */
const loginOnly = async (
  clientId: string,
  redirectUri: string,
  email: string,
  password: string,
  extra: Record<string, string> = {}
) => {
  const jar: CookieJar = new Map();
  const { params, pkce, response } = authorize(
    jar,
    clientId,
    redirectUri,
    extra
  );
  absorbCookies(jar, await response);
  const submit = await fetch(`${BASE_URL}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify({ ...params, email, password }),
  });
  absorbCookies(jar, submit);
  expect(submit.status).toBe(200);
  const { redirect_url } = (await submit.json()) as { redirect_url: string };
  return { url: new URL(redirect_url), pkce, jar };
};

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
  skipping = await createSkippingClient();
  skippingCore = await createSkippingClient(["openid", "core:account"]);
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

  it("answers prompt=none with a code for a consentRequired:false client", async () => {
    const { jar } = await signIn(skipping.clientId, SKIPPING_REDIRECT);
    const { pkce, response } = authorize(
      jar,
      skipping.clientId,
      SKIPPING_REDIRECT,
      { prompt: "none" }
    );
    const res = await response;
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBeNull();
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();
    const tokens = await exchange(
      skipping.clientId,
      SKIPPING_REDIRECT,
      code!,
      pkce.verifier
    );
    expect(tokens.status).toBe(200);
  });

  it("answers a consentRequired:false client consent_required when it asks for a core scope", async () => {
    const { jar } = await signIn(skippingCore.clientId, SKIPPING_REDIRECT);
    const { response } = authorize(
      jar,
      skippingCore.clientId,
      SKIPPING_REDIRECT,
      { prompt: "none", scope: "openid core:account" }
    );
    const res = await response;
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("consent_required");
    expect(location.searchParams.get("code")).toBeNull();
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

describe("trusted core scopes", () => {
  const TRUSTING_REDIRECT = "http://localhost:3100/trusts-core/callback";
  const trustingClientId = `prov-client-${randomBytes(5).toString("hex")}`;

  beforeAll(async () => {
    // Events are written in this process, outside the server.
    await ensureDefaultOrganization();
    await applyProvisioning({
      documents: [
        {
          file: "trusting.json",
          version: "1.0.0",
          service: null,
          roles: [],
          clients: [
            {
              clientId: trustingClientId,
              name: "Trusts core scopes",
              description: null,
              clientType: "public",
              secretEnv: null,
              secretHash: null,
              redirectUris: [TRUSTING_REDIRECT],
              postLogoutRedirectUris: [],
              scopes: ["openid", "core:files.read", "core:account"],
              grantTypes: ["authorization_code", "refresh_token"],
              audience: [],
              consentRequired: false,
              trustedCoreScopes: ["core:files.read"],
            },
          ],
        },
      ],
    });
  });

  afterAll(() => removeLoginClients([trustingClientId]));

  it("answers prompt=none with a code for a trusted core scope, and the token keeps its ceiling", async () => {
    const { user, jar } = await signIn(trustingClientId, TRUSTING_REDIRECT);
    await getTestPrincipalToken({ userId: user.id, permissions: ["admin"] });

    const { pkce, response } = authorize(
      jar,
      trustingClientId,
      TRUSTING_REDIRECT,
      { prompt: "none", scope: "openid core:files.read" }
    );
    const res = await response;
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBeNull();
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokens = await exchange(
      trustingClientId,
      TRUSTING_REDIRECT,
      code!,
      pkce.verifier
    );
    expect(tokens.status).toBe(200);
    const { access_token } = (await tokens.json()) as { access_token: string };
    const call = (init: RequestInit = {}) =>
      fetch(`${BASE_URL}/v1/files/buckets`, {
        ...init,
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
        },
      });
    expect((await call()).status).toBe(200);
    const create = await call({
      method: "POST",
      body: JSON.stringify({ name: `trusted-${Date.now()}` }),
    });
    expect(create.status).toBe(403);
  });

  it("issues the code at once after password login for a trusted core scope", async () => {
    const user = await createTestUser();
    const { url } = await loginOnly(
      trustingClientId,
      TRUSTING_REDIRECT,
      user.email,
      user.plainPassword,
      { scope: "openid core:files.read" }
    );
    expect(`${url.origin}${url.pathname}`).toBe(TRUSTING_REDIRECT);
    expect(url.searchParams.get("code")).toBeTruthy();
    expect(
      await prisma.consentSession.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("answers consent_required for a core scope the client does not trust", async () => {
    const { jar } = await signIn(trustingClientId, TRUSTING_REDIRECT);
    const { response } = authorize(jar, trustingClientId, TRUSTING_REDIRECT, {
      prompt: "none",
      scope: "openid core:files.read core:account",
    });
    const location = new URL((await response).headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("consent_required");
    expect(location.searchParams.get("code")).toBeNull();
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

  it("issues the code at once on an org_id switch for a consentRequired:false client", async () => {
    const { user, jar } = await signIn(skipping.clientId, SKIPPING_REDIRECT);
    const orgId = await joinOrg(user.id);
    const { response } = authorize(jar, skipping.clientId, SKIPPING_REDIRECT, {
      org_id: orgId,
    });
    const res = await response;
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(SKIPPING_REDIRECT);
    expect(location.searchParams.get("code")).toBeTruthy();
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

describe("consent after password login", () => {
  it("issues the code at once for a consentRequired:false client", async () => {
    const user = await createTestUser();
    const { url, pkce } = await loginOnly(
      skipping.clientId,
      SKIPPING_REDIRECT,
      user.email,
      user.plainPassword
    );
    expect(`${url.origin}${url.pathname}`).toBe(SKIPPING_REDIRECT);
    expect(url.searchParams.get("state")).toBe(pkce.state);
    const code = url.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(
      await prisma.consentSession.count({ where: { userId: user.id } })
    ).toBe(0);

    const tokens = await exchange(
      skipping.clientId,
      SKIPPING_REDIRECT,
      code!,
      pkce.verifier
    );
    expect(tokens.status).toBe(200);
  });

  it("issues the code at once for core's own login client", async () => {
    const user = await createTestUser();
    const { url } = await loginOnly(
      LOGIN_CLIENT.clientId,
      loginRedirectUri,
      user.email,
      user.plainPassword
    );
    expect(`${url.origin}${url.pathname}`).toBe(loginRedirectUri);
    expect(url.searchParams.get("code")).toBeTruthy();
    expect(
      await prisma.consentSession.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("issues the code at once after the org picker for a consentRequired:false client", async () => {
    const user = await createTestUser();
    for (const label of ["picker-a", "picker-b"]) {
      const organizationId = await ensureTestOrganization(
        `first-party-${label}-${user.id}`
      );
      await prisma.organizationMember.create({
        data: { organizationId, userId: user.id },
      });
    }
    const { url, jar } = await loginOnly(
      skipping.clientId,
      SKIPPING_REDIRECT,
      user.email,
      user.plainPassword
    );
    expect(url.pathname).toMatch(/\/login\/org-select$/);
    const session = url.searchParams.get("session");

    const membership = await prisma.organizationMember.findFirstOrThrow({
      where: { userId: user.id },
    });
    const pick = await fetch(`${BASE_URL}/oauth/org-select/submit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({
        session_token: session,
        organization_id: membership.organizationId,
      }),
    });
    expect(pick.status).toBe(200);
    const { redirect_url } = (await pick.json()) as { redirect_url: string };
    const done = new URL(redirect_url);
    expect(`${done.origin}${done.pathname}`).toBe(SKIPPING_REDIRECT);
    expect(done.searchParams.get("code")).toBeTruthy();
    expect(
      await prisma.consentSession.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("shows a consentRequired:false client the consent screen when it asks for a core scope", async () => {
    const user = await createTestUser();
    const { url } = await loginOnly(
      skippingCore.clientId,
      SKIPPING_REDIRECT,
      user.email,
      user.plainPassword,
      { scope: "openid core:account" }
    );
    expect(url.pathname).toMatch(/\/consent$/);
    expect(url.searchParams.get("code")).toBeNull();
    expect(
      await prisma.consentSession.count({ where: { userId: user.id } })
    ).toBe(1);
  });

  it("still skips consent for that client when it asks for no core scope", async () => {
    const user = await createTestUser();
    const { url } = await loginOnly(
      skippingCore.clientId,
      SKIPPING_REDIRECT,
      user.email,
      user.plainPassword
    );
    expect(`${url.origin}${url.pathname}`).toBe(SKIPPING_REDIRECT);
    expect(url.searchParams.get("code")).toBeTruthy();
    expect(
      await prisma.consentSession.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("issues the code at once after password and TOTP for a consentRequired:false client", async () => {
    const user = await createTestUser();
    const secret = generateTotpSecret();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        totpSecret: encryptTotpSecret(secret),
        totpEnabled: true,
        totpEnabledAt: new Date(),
      },
    });
    const { url, jar } = await loginOnly(
      skipping.clientId,
      SKIPPING_REDIRECT,
      user.email,
      user.plainPassword
    );
    expect(url.pathname).toBe("/login/2fa");

    const verify = await fetch(`${BASE_URL}/oauth/totp/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(jar),
      },
      body: JSON.stringify({
        session_token: url.searchParams.get("session"),
        totp_code: generateTotpCode(secret),
      }),
    });
    expect(verify.status).toBe(200);
    const { redirect_url } = (await verify.json()) as { redirect_url: string };
    const done = new URL(redirect_url);
    expect(`${done.origin}${done.pathname}`).toBe(SKIPPING_REDIRECT);
    expect(done.searchParams.get("code")).toBeTruthy();
    expect(
      await prisma.consentSession.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("still shows a default client the consent screen after password login", async () => {
    const user = await createTestUser();
    const { url } = await loginOnly(
      thirdParty.clientId,
      THIRD_PARTY_REDIRECT,
      user.email,
      user.plainPassword
    );
    expect(url.pathname).toMatch(/\/consent$/);
    expect(url.searchParams.get("code")).toBeNull();
    expect(
      await prisma.consentSession.count({ where: { userId: user.id } })
    ).toBe(1);
  });

  it("gives a consentRequired:false client's token no core API access beyond its scopes", async () => {
    const admin = await createAdminUser();
    const { url, pkce } = await loginOnly(
      skipping.clientId,
      SKIPPING_REDIRECT,
      admin.email,
      admin.plainPassword
    );
    const tokens = await exchange(
      skipping.clientId,
      SKIPPING_REDIRECT,
      url.searchParams.get("code")!,
      pkce.verifier
    );
    expect(tokens.status).toBe(200);
    const { access_token } = (await tokens.json()) as { access_token: string };

    const users = await fetch(`${BASE_URL}/v1/admin/users`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    // Not issued for core's API at all, however much the user may do there.
    expect(users.status).toBe(401);
    expect(((await users.json()) as { error: string }).error).toBe(
      "invalid_token"
    );
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
