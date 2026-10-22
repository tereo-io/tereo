// @module-tag int
// @module-tag auth
import { generateTotpSecret, encryptTotpSecret } from "../../../utils/totp.js";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { LOGIN_CLIENT } from "../../../definitions/index.js";
import { prisma } from "../../../utils/db/prisma.js";
import {
  absorbCookies,
  cookieHeader,
  newPkce,
  type CookieJar,
} from "../../support/browserLogin.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestRole,
  createTestUser,
  generateTotpCode,
} from "../../support/auth.js";

/**
 * 2FA made required after a password-only sign-in (a role the user holds
 * gains `requires2fa`, or the policy becomes `required`) is enforced on what
 * that sign-in still allows: a silent login or an org switch goes back
 * through the login, and a refresh is refused.
 */

let redirectUri: string;

beforeAll(async () => {
  const ui = await prisma.oAuthClient.findUniqueOrThrow({
    where: { clientId: LOGIN_CLIENT.clientId },
  });
  redirectUri = ui.redirectUris[0];
});

const setPolicy = (value: string) =>
  prisma.systemSetting.upsert({
    where: { key: "totpPolicy" },
    update: { value },
    create: { key: "totpPolicy", value },
  });

afterEach(async () => {
  await setPolicy("optional");
});

const authorizeParams = (extra: Record<string, string> = {}) => {
  const pkce = newPkce();
  return {
    pkce,
    params: {
      response_type: "code",
      client_id: LOGIN_CLIENT.clientId,
      redirect_uri: redirectUri,
      state: pkce.state,
      scope: "openid",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      ...extra,
    },
  };
};

const post = async (jar: CookieJar, path: string, body: object) => {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify(body),
  });
  absorbCookies(jar, res);
  expect(res.status).toBe(HTTP_STATUS.OK);
  return new URL(((await res.json()) as { redirect_url: string }).redirect_url);
};

/**
 * A login through to consent, with a TOTP code when one is asked for. The
 * jar keeps the SSO session; returns the code exchange's tokens.
 */
const signInForTokens = async (
  jar: CookieJar,
  user: { email: string; plainPassword: string; secret?: string }
) => {
  const { pkce, params } = authorizeParams();
  const start = await fetch(
    `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
    { redirect: "manual", headers: { Cookie: cookieHeader(jar) } }
  );
  absorbCookies(jar, start);
  let next = await post(jar, "/oauth/authorize", {
    ...params,
    email: user.email,
    password: user.plainPassword,
  });
  if (user.secret) {
    expect(next.pathname).toMatch(/\/login\/2fa$/);
    next = await post(jar, "/oauth/totp/verify", {
      session_token: next.searchParams.get("session"),
      totp_code: generateTotpCode(user.secret),
    });
  }
  // Core's own login client skips consent: the code comes with the login.
  const done = next.searchParams.has("code")
    ? next
    : await post(jar, "/oauth/consent", {
        session_token: next.searchParams.get("session"),
        approved: true,
      });
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: done.searchParams.get("code"),
      redirect_uri: redirectUri,
      client_id: LOGIN_CLIENT.clientId,
      code_verifier: pkce.verifier,
    }),
  });
  expect(res.status).toBe(HTTP_STATUS.OK);
  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token: string;
  };
  expect(tokens.refresh_token).toBeTruthy();
  return tokens;
};

const signIn = async (
  jar: CookieJar,
  user: { email: string; plainPassword: string; secret?: string }
) => (await signInForTokens(jar, user)).refresh_token;

const userinfoStatus = async (accessToken: string) =>
  (
    await fetch(`${BASE_URL}/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
  ).status;

const adminCall = (
  token: string,
  method: string,
  path: string,
  body: unknown
) =>
  fetch(`${BASE_URL}/v1/admin${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

/** GET /oauth/authorize with the SSO cookie; returns where it redirects. */
const continueSession = async (
  jar: CookieJar,
  extra: Record<string, string>
) => {
  const { params } = authorizeParams(extra);
  const res = await fetch(
    `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
    { redirect: "manual", headers: { Cookie: cookieHeader(jar) } }
  );
  expect(res.status).toBe(HTTP_STATUS.FOUND);
  return new URL(res.headers.get("location") ?? "");
};

const silentLogin = (jar: CookieJar) =>
  continueSession(jar, { prompt: "none" });

const refresh = (refreshToken: string) =>
  fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: LOGIN_CLIENT.clientId,
    }),
  });

/** A user holding a global role that does not require 2FA yet. */
const createUserWithRole = async () => {
  const user = await createTestUser();
  const role = await createTestRole();
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  const require2fa = () =>
    prisma.role.update({ where: { id: role.id }, data: { requires2fa: true } });
  return { user, require2fa };
};

const createTotpUser = async () => {
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
  return { ...user, secret };
};

const joinOrg = async (userId: string) => {
  const orgId = await ensureTestOrganization(`step-up-${userId}`);
  await prisma.organizationMember.create({
    data: { organizationId: orgId, userId },
  });
  return orgId;
};

describe("2FA required after a password-only sign-in", () => {
  it("refuses a silent login once a role the user holds requires 2FA", async () => {
    const { user, require2fa } = await createUserWithRole();
    const jar: CookieJar = new Map();
    await signIn(jar, user);
    expect((await silentLogin(jar)).searchParams.get("code")).toBeTruthy();

    await require2fa();

    const location = await silentLogin(jar);
    expect(`${location.origin}${location.pathname}`).toBe(redirectUri);
    expect(location.searchParams.get("error")).toBe("interaction_required");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("refuses a refresh once the 2FA policy becomes required", async () => {
    const user = await createTestUser();
    const refreshToken = await signIn(new Map(), user);
    const first = await refresh(refreshToken);
    expect(first.status).toBe(HTTP_STATUS.OK);
    const { refresh_token } = (await first.json()) as { refresh_token: string };

    await setPolicy("required");

    const res = await refresh(refresh_token);
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_grant"
    );
  });

  it("sends an org switch through the login once a role requires 2FA", async () => {
    const { user, require2fa } = await createUserWithRole();
    const orgId = await joinOrg(user.id);
    const jar: CookieJar = new Map();
    await signIn(jar, user);
    expect(
      (await continueSession(jar, { org_id: orgId })).searchParams.get("code")
    ).toBeTruthy();

    await require2fa();

    const location = await continueSession(jar, { org_id: orgId });
    expect(location.pathname).toMatch(/\/login$/);
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("lets a user who signed in with 2FA continue silently, switch and refresh", async () => {
    const user = await createTotpUser();
    const orgId = await joinOrg(user.id);
    const jar: CookieJar = new Map();
    const refreshToken = await signIn(jar, user);

    await setPolicy("required");

    expect((await silentLogin(jar)).searchParams.get("code")).toBeTruthy();
    expect(
      (await continueSession(jar, { org_id: orgId })).searchParams.get("code")
    ).toBeTruthy();
    expect((await refresh(refreshToken)).status).toBe(HTTP_STATUS.OK);
  });

  it("leaves client credentials alone", async () => {
    const client = await createTestClient({
      clientType: "confidential",
      grantTypes: ["client_credentials"],
      scopes: ["openid"],
    });
    await setPolicy("required");

    const res = await fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(
          `${client.clientId}:${client.plainSecret}`
        ).toString("base64")}`,
      },
      body: JSON.stringify({ grant_type: "client_credentials" }),
    });
    expect(res.status).toBe(HTTP_STATUS.OK);
  });
});

describe("revoking password-only access tokens when 2FA becomes required", () => {
  it("revokes them when the policy becomes required, sparing logins with 2FA", async () => {
    const password = await signInForTokens(new Map(), await createTestUser());
    const withTotp = await signInForTokens(new Map(), await createTotpUser());
    expect(await userinfoStatus(password.access_token)).toBe(HTTP_STATUS.OK);

    const admin = await getTestPrincipalToken({ permissions: ["admin"] });
    const res = await adminCall(admin, "PATCH", "/settings", {
      totpPolicy: "required",
    });
    expect(res.status).toBe(HTTP_STATUS.OK);

    expect(await userinfoStatus(password.access_token)).toBe(
      HTTP_STATUS.UNAUTHORIZED
    );
    expect(await userinfoStatus(withTotp.access_token)).toBe(HTTP_STATUS.OK);
    expect((await refresh(password.refresh_token)).status).toBe(
      HTTP_STATUS.BAD_REQUEST
    );
  });

  it("revokes only holders of a role requiring 2FA when the policy leaves disabled", async () => {
    await setPolicy("disabled");
    const holder = await createUserWithRole();
    const holderTokens = await signInForTokens(new Map(), holder.user);
    const other = await signInForTokens(new Map(), await createTestUser());
    await holder.require2fa();

    const admin = await getTestPrincipalToken({ permissions: ["admin"] });
    const res = await adminCall(admin, "PATCH", "/settings", {
      totpPolicy: "optional",
    });
    expect(res.status).toBe(HTTP_STATUS.OK);

    expect(await userinfoStatus(holderTokens.access_token)).toBe(
      HTTP_STATUS.UNAUTHORIZED
    );
    expect(await userinfoStatus(other.access_token)).toBe(HTTP_STATUS.OK);
  });

  it("revokes a holder's when their role comes to require 2FA", async () => {
    const role = await createTestRole();
    const user = await createTestUser();
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id },
    });
    const tokens = await signInForTokens(new Map(), user);
    const rolesWriter = await getTestPrincipalToken({
      permissions: ["roles.write"],
    });

    const renamed = await adminCall(rolesWriter, "PATCH", `/roles/${role.id}`, {
      displayName: "Still optional",
    });
    expect(renamed.status).toBe(HTTP_STATUS.OK);
    expect(await userinfoStatus(tokens.access_token)).toBe(HTTP_STATUS.OK);

    const res = await adminCall(rolesWriter, "PATCH", `/roles/${role.id}`, {
      requires2fa: true,
    });
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(await userinfoStatus(tokens.access_token)).toBe(
      HTTP_STATUS.UNAUTHORIZED
    );
    expect((await refresh(tokens.refresh_token)).status).toBe(
      HTTP_STATUS.BAD_REQUEST
    );
  });

  it("revokes a user's when they are given a role requiring 2FA, globally or in an organization", async () => {
    const usersWriter = await getTestPrincipalToken({
      permissions: ["users.write", "organizations.write"],
    });
    const plainRole = await createTestRole();
    const strictRole = await createTestRole();
    await prisma.role.update({
      where: { id: strictRole.id },
      data: { requires2fa: true },
    });

    const user = await createTestUser();
    const tokens = await signInForTokens(new Map(), user);
    const plain = await adminCall(
      usersWriter,
      "PUT",
      `/users/${user.id}/roles`,
      {
        roleIds: [plainRole.id],
      }
    );
    expect(plain.status).toBe(HTTP_STATUS.OK);
    expect(await userinfoStatus(tokens.access_token)).toBe(HTTP_STATUS.OK);
    const strict = await adminCall(
      usersWriter,
      "PUT",
      `/users/${user.id}/roles`,
      { roleIds: [plainRole.id, strictRole.id] }
    );
    expect(strict.status).toBe(HTTP_STATUS.OK);
    expect(await userinfoStatus(tokens.access_token)).toBe(
      HTTP_STATUS.UNAUTHORIZED
    );

    const member = await createTestUser();
    const orgId = await joinOrg(member.id);
    const memberTokens = await signInForTokens(new Map(), member);
    const inOrg = await adminCall(
      usersWriter,
      "PUT",
      `/organizations/${orgId}/members/${member.id}/roles`,
      { roleIds: [strictRole.id] }
    );
    expect(inOrg.status).toBe(HTTP_STATUS.OK);
    expect(await userinfoStatus(memberTokens.access_token)).toBe(
      HTTP_STATUS.UNAUTHORIZED
    );
  });
});
