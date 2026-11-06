// @module-tag int
// @module-tag auth
import { ensureTestOrganization } from "../../support/principals.js";
import { createTestClient } from "../../support/auth/clients.js";
import { createTestGuest } from "../../support/auth/guests.js";
import { createTestUser } from "../../support/auth/users.js";
import { BASE_URL } from "../../support/auth/constants.js";
import { prisma } from "../../../utils/db/prisma.js";
import { describe, expect, it } from "vitest";
import {
  absorbCookies,
  browserLogin,
  cookieHeader,
  newPkce,
  type CookieJar,
} from "../../support/browserLogin.js";

const SCOPE = "openid profile email";
const NEW_PASSWORD = "BrandNewPassw0rd!";

const flaggedUser = async () => {
  const user = await createTestUser();
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordChangeRequired: true },
  });
  return user;
};

// Password step of /oauth/authorize, up to the redirect it answers.
const submitPassword = async (
  client: { clientId: string; redirectUris: string[] },
  user: { email: string; plainPassword: string },
  jar: CookieJar = new Map()
) => {
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
    { redirect: "manual", headers: { Cookie: cookieHeader(jar) } }
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
  return { jar, redirectUrl: new URL(redirect_url) };
};

const toChangePassword = async (
  client: { clientId: string; redirectUris: string[] },
  user: { email: string; plainPassword: string }
) => {
  const { jar, redirectUrl } = await submitPassword(client, user);
  expect(redirectUrl.pathname).toBe("/login/change-password");
  return { jar, grant: redirectUrl.searchParams.get("change_grant")! };
};

const changePassword = (
  body: Record<string, unknown>,
  jar?: CookieJar
): Promise<Response> =>
  fetch(`${BASE_URL}/oauth/password-change`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(jar ? { Cookie: cookieHeader(jar) } : {}),
    },
    body: JSON.stringify(body),
  });

describe("forced password change at sign-in", () => {
  it("login with passwordChangeRequired redirects to change-password and issues no code", async () => {
    const client = await createTestClient();
    const user = await flaggedUser();

    const { jar, redirectUrl } = await submitPassword(client, user);

    expect(redirectUrl.pathname).toBe("/login/change-password");
    expect(redirectUrl.searchParams.get("change_grant")).toBeTruthy();
    expect(redirectUrl.searchParams.get("client_id")).toBe(client.clientId);
    expect(redirectUrl.searchParams.has("code")).toBe(false);
    expect(redirectUrl.searchParams.has("session")).toBe(false);
    expect(
      [...jar.keys()].some((name) =>
        name.includes("tereo_password_change_grant")
      )
    ).toBe(true);
    expect(
      await prisma.authorizationCode.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("grant is single use and bound to the cookie", async () => {
    const client = await createTestClient();
    const user = await flaggedUser();
    const { jar, grant } = await toChangePassword(client, user);

    const noCookie = await changePassword({
      change_grant: grant,
      password: NEW_PASSWORD,
    });
    expect(noCookie.status).toBe(400);
    expect(((await noCookie.json()) as { error: string }).error).toBe(
      "invalid_change_grant"
    );
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
        .passwordChangeRequired
    ).toBe(true);

    const ok = await changePassword(
      { change_grant: grant, password: NEW_PASSWORD },
      jar
    );
    expect(ok.status).toBe(204);

    const replay = await changePassword(
      { change_grant: grant, password: "AnotherPassw0rd!x" },
      jar
    );
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe(
      "invalid_change_grant"
    );
  });

  it("after change, authorize completes and the flag is clear", async () => {
    const client = await createTestClient();
    const user = await flaggedUser();
    const { jar, grant } = await toChangePassword(client, user);

    const res = await changePassword(
      { change_grant: grant, password: NEW_PASSWORD },
      jar
    );
    expect(res.status).toBe(204);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
        .passwordChangeRequired
    ).toBe(false);

    const old = await submitPasswordRaw(client, user.email, user.plainPassword);
    expect(old.status).toBe(401);

    const login = await browserLogin({
      clientId: client.clientId,
      redirectUri: client.redirectUris[0],
      scope: SCOPE,
      email: user.email,
      password: NEW_PASSWORD,
    });
    expect(login.code).toBeTruthy();
  });

  it("refuses a grant once its guest has expired", async () => {
    const client = await createTestClient();
    const { user, plainPassword } = await createTestGuest({
      organizationId: await ensureTestOrganization("forced-change-guest"),
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordChangeRequired: true },
    });
    const { jar, grant } = await toChangePassword(client, {
      email: user.email,
      plainPassword,
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await changePassword(
      { change_grant: grant, password: NEW_PASSWORD },
      jar
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_change_grant"
    );
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(after.passwordHash).toBe(user.passwordHash);
  });

  it("the new password must differ from the current one", async () => {
    const client = await createTestClient();
    const user = await flaggedUser();
    const { jar, grant } = await toChangePassword(client, user);

    const res = await changePassword(
      { change_grant: grant, password: user.plainPassword },
      jar
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "password_unchanged"
    );
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
        .passwordChangeRequired
    ).toBe(true);
  });

  it("rejects a password that breaks the password rules", async () => {
    const client = await createTestClient();
    const user = await flaggedUser();
    const { jar, grant } = await toChangePassword(client, user);

    const res = await changePassword(
      { change_grant: grant, password: "short" },
      jar
    );
    expect(res.status).toBe(400);
  });

  it("humans with the flag clear are unaffected", async () => {
    const client = await createTestClient();
    const user = await createTestUser();

    const login = await browserLogin({
      clientId: client.clientId,
      redirectUri: client.redirectUris[0],
      scope: SCOPE,
      email: user.email,
      password: user.plainPassword,
    });

    expect(login.code).toBeTruthy();
    expect(login.redirectUrl).not.toContain("change-password");
  });
});

// A password POST with a fresh authorize session, for the status alone.
async function submitPasswordRaw(
  client: { clientId: string; redirectUris: string[] },
  email: string,
  password: string
) {
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
  return fetch(`${BASE_URL}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    body: JSON.stringify({ ...params, email, password }),
  });
}
