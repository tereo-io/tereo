// @module-tag int
// @module-tag auth
// @module-tag security
import { encryptTotpSecret, generateTotpSecret } from "../../../utils/totp.js";
import { createAdminUser, createTestUser } from "../../support/auth/users.js";
import { BASE_URL, HTTP_STATUS } from "../../support/auth/constants.js";
import { createTestClient } from "../../support/auth/clients.js";
import { generateTotpCode } from "../../support/auth/crypto.js";
import { prisma } from "../../../utils/db/prisma.js";
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  addTestOrgMember,
  createTestOrganization,
} from "../../support/auth/organizations.js";
import {
  absorbCookies,
  browserLogin,
  cookieHeader,
  newPkce,
  userSessionCookieName,
} from "../../support/browserLogin.js";
import {
  getAccessTokenForUser,
  getUiAccessTokenForUser,
} from "../../support/auth/login.js";

/**
 * The 2FA, org-select and consent steps of a login each hand the browser a
 * token, in the URL and a cookie. The database keeps only its SHA-256, so a
 * leaked row can't be replayed into the flow.
 */

const REDIRECT_URI = "http://localhost:3000/callback";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const expectStoredHashed = (row: { tokenHash: string }, token: string) => {
  expect(row.tokenHash).toBe(sha256(token));
  expect(JSON.stringify(row)).not.toContain(token);
};

const redirectOf = async (res: Response) =>
  new URL(((await res.json()) as { redirect_url: string }).redirect_url);

describe("login flow session tokens", () => {
  it("stores the 2FA, org-select and consent tokens only as hashes, and the raw ones still work", async () => {
    const client = await createTestClient();
    const admin = await createAdminUser();
    const adminToken = await getAccessTokenForUser(admin, client);
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
    // Two organizations, so the login stops at the org picker.
    const orgs = [
      await createTestOrganization(adminToken),
      await createTestOrganization(adminToken),
    ];
    for (const org of orgs) await addTestOrgMember(adminToken, org.id, user.id);

    const jar = new Map<string, string>();
    const post = async (path: string, body: object) => {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader(jar),
        },
        body: JSON.stringify(body),
      });
      absorbCookies(jar, res);
      return res;
    };

    const pkce = newPkce();
    const params = {
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      state: pkce.state,
      scope: "openid",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    };
    absorbCookies(
      jar,
      await fetch(
        `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
        { redirect: "manual" }
      )
    );

    // Password → the 2FA page.
    const login = await post("/oauth/authorize", {
      ...params,
      email: user.email,
      password: user.plainPassword,
    });
    expect(login.status).toBe(HTTP_STATUS.OK);
    const twoFa = await redirectOf(login);
    expect(twoFa.pathname).toBe("/login/2fa");
    const twoFaToken = twoFa.searchParams.get("session")!;
    expect(jar.get(`tereo_2fa_session_${client.clientId}`)).toBe(twoFaToken);
    expectStoredHashed(
      await prisma.totpVerification.findFirstOrThrow({
        where: { userId: user.id },
      }),
      twoFaToken
    );

    // TOTP → the org picker.
    const verified = await post("/oauth/totp/verify", {
      session_token: twoFaToken,
      totp_code: generateTotpCode(secret),
    });
    expect(verified.status).toBe(HTTP_STATUS.OK);
    const orgSelect = await redirectOf(verified);
    expect(orgSelect.pathname).toBe("/login/org-select");
    const orgSelectToken = orgSelect.searchParams.get("session")!;
    expect(jar.get(`tereo_org_select_session_${client.clientId}`)).toBe(
      orgSelectToken
    );
    expectStoredHashed(
      await prisma.orgSelectionSession.findFirstOrThrow({
        where: { userId: user.id },
      }),
      orgSelectToken
    );
    expect(
      (
        await fetch(
          `${BASE_URL}/oauth/org-select?session=${encodeURIComponent(orgSelectToken)}`,
          { headers: { Cookie: cookieHeader(jar) } }
        )
      ).status
    ).toBe(HTTP_STATUS.OK);

    // Organization → consent.
    const selected = await post("/oauth/org-select/submit", {
      session_token: orgSelectToken,
      organization_id: orgs[0].id,
    });
    expect(selected.status).toBe(HTTP_STATUS.OK);
    const consent = await redirectOf(selected);
    expect(consent.pathname).toBe("/consent");
    const consentToken = consent.searchParams.get("session")!;
    expect(jar.get(`tereo_consent_session_${client.clientId}`)).toBe(
      consentToken
    );
    expectStoredHashed(
      await prisma.consentSession.findFirstOrThrow({
        where: { userId: user.id },
      }),
      consentToken
    );
    const details = await fetch(
      `${BASE_URL}/oauth/consent?session=${encodeURIComponent(consentToken)}`,
      { headers: { Cookie: cookieHeader(jar) } }
    );
    expect(details.status).toBe(HTTP_STATUS.OK);
    expect(
      ((await details.json()) as { sessionToken: string }).sessionToken
    ).toBe(consentToken);

    // The stored hash is no token: presented as one, it finds nothing.
    const asToken = await fetch(
      `${BASE_URL}/oauth/consent?session=${sha256(consentToken)}`,
      { headers: { Cookie: cookieHeader(jar) } }
    );
    expect(asToken.status).toBe(HTTP_STATUS.BAD_REQUEST);

    const approved = await post("/oauth/consent", {
      session_token: consentToken,
      approved: true,
    });
    expect(approved.status).toBe(HTTP_STATUS.OK);
    expect((await redirectOf(approved)).searchParams.get("code")).toBeTruthy();
  });

  it("stores the SSO session token only as a hash; the cookie's raw token signs in silently", async () => {
    const client = await createTestClient();
    const user = await createTestUser();
    const { jar } = await browserLogin({
      clientId: client.clientId,
      redirectUri: REDIRECT_URI,
      scope: "openid",
      email: user.email,
      password: user.plainPassword,
    });
    const cookieName = userSessionCookieName(client.clientId);
    const ssoToken = jar.get(cookieName)!;
    expectStoredHashed(
      await prisma.userSession.findFirstOrThrow({
        where: { userId: user.id },
      }),
      ssoToken
    );

    const silent = (cookie: string) => {
      const pkce = newPkce();
      return fetch(
        `${BASE_URL}/oauth/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: client.clientId,
          redirect_uri: REDIRECT_URI,
          state: pkce.state,
          scope: "openid",
          code_challenge: pkce.challenge,
          code_challenge_method: "S256",
          prompt: "none",
        })}`,
        { redirect: "manual", headers: { Cookie: `${cookieName}=${cookie}` } }
      ).then((res) => new URL(res.headers.get("location") ?? ""));
    };
    // The session is accepted; a third-party client still needs consent.
    expect((await silent(ssoToken)).searchParams.get("error")).toBe(
      "consent_required"
    );
    // The stored hash is no token.
    expect((await silent(sha256(ssoToken))).searchParams.get("error")).toBe(
      "login_required"
    );
  });

  it("stores the 2FA setup token only as a hash, and the raw one still verifies", async () => {
    const user = await createTestUser();
    const accessToken = await getUiAccessTokenForUser(user);
    const post = (path: string, body: object) =>
      fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

    const setup = await post("/v1/account/totp/setup", {});
    expect(setup.status).toBe(HTTP_STATUS.OK);
    const { secret, setupToken } = (await setup.json()) as {
      secret: string;
      setupToken: string;
    };
    expectStoredHashed(
      await prisma.totpSetupSession.findFirstOrThrow({
        where: { userId: user.id },
      }),
      setupToken
    );

    const asToken = await post("/v1/account/totp/setup/verify", {
      setupToken: sha256(setupToken),
      totpCode: generateTotpCode(secret),
    });
    expect(asToken.status).toBe(HTTP_STATUS.BAD_REQUEST);

    const verified = await post("/v1/account/totp/setup/verify", {
      setupToken,
      totpCode: generateTotpCode(secret),
    });
    expect(verified.status).toBe(HTTP_STATUS.OK);
  });
});
