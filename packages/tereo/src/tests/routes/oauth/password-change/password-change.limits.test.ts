// @module-tag int
// @module-tag auth
// @module-tag security
import { createTestClient } from "../../../support/auth/clients.js";
import { createTestUser } from "../../../support/auth/users.js";
import { BASE_URL } from "../../../support/auth/constants.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { describe, expect, it } from "vitest";
import {
  absorbCookies,
  cookieHeader,
  newPkce,
  type CookieJar,
} from "../../../support/browserLogin.js";

const MAX_FAILURES = 10;
const IP = "203.0.113.201";

/** Signs a flagged user in up to the forced change: its grant and cookie. */
const toChangePassword = async () => {
  const client = await createTestClient();
  const user = await createTestUser();
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordChangeRequired: true },
  });
  const jar: CookieJar = new Map();
  const pkce = newPkce();
  const params = {
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUris[0],
    state: pkce.state,
    scope: "openid",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  };
  const start = await fetch(
    `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
    { redirect: "manual" }
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
  const { redirect_url } = (await submit.json()) as { redirect_url: string };
  const grant = new URL(redirect_url).searchParams.get("change_grant");
  expect(grant).toBeTruthy();
  return { user, jar, grant: grant! };
};

const changePassword = (
  body: Record<string, string>,
  jar?: CookieJar
): Promise<Response> =>
  fetch(`${BASE_URL}/oauth/password-change`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Forwarded-For": IP,
      ...(jar ? { Cookie: cookieHeader(jar) } : {}),
    },
    body: new URLSearchParams(body),
  });

describe("POST /oauth/password-change", () => {
  it("spends no attempt on a request without the grant's cookie", async () => {
    const { jar, grant } = await toChangePassword();
    // What a page elsewhere can post from a visitor's browser: no cookie,
    // with or without a real grant.
    for (let i = 0; i < MAX_FAILURES + 1; i++) {
      const res = await changePassword({
        change_grant: i % 2 ? grant : "not-a-grant",
        password: "BrandNewPassw0rd!",
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "invalid_change_grant"
      );
    }
    const ok = await changePassword(
      { change_grant: grant, password: "BrandNewPassw0rd!" },
      jar
    );
    expect(ok.status).toBe(204);
  });

  it("refuses an eleventh rejected password in the grant's browser", async () => {
    const { user, jar, grant } = await toChangePassword();
    for (let i = 0; i < MAX_FAILURES; i++) {
      const res = await changePassword(
        { change_grant: grant, password: user.plainPassword },
        jar
      );
      expect(res.status).toBe(400);
    }
    const res = await changePassword(
      { change_grant: grant, password: user.plainPassword },
      jar
    );
    expect(res.status).toBe(429);
  });
});
