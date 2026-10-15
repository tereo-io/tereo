import { generateTotpSecret, encryptTotpSecret } from "../../utils/totp.js";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { LOGIN_CLIENT } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
import {
  absorbCookies,
  cookieHeader,
  newPkce,
  type CookieJar,
} from "../utils/browserLogin.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestUser,
  decodeJwt,
  generateTotpCode,
} from "./utils/test-helpers.js";

/**
 * `acr_values=urn:auth-service:mfa` is enforced: the login must complete a
 * second factor, a silent request over a password-only session gets
 * `interaction_required`, and the ID token's `acr` says what happened.
 */

const MFA = "urn:auth-service:mfa";
const PWD = "urn:auth-service:pwd";

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

const authorizeParams = (acrValues?: string, extra = {}) => {
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
      ...(acrValues && { acr_values: acrValues }),
      ...extra,
    } as Record<string, string>,
  };
};

/** GET then POST /oauth/authorize; returns where the login goes next. */
const submitLogin = async (
  jar: CookieJar,
  user: { email: string; plainPassword: string },
  acrValues?: string
) => {
  const { pkce, params } = authorizeParams(acrValues);
  const start = await fetch(
    `${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`,
    { redirect: "manual", headers: { Cookie: cookieHeader(jar) } }
  );
  absorbCookies(jar, start);
  expect(start.status).toBe(HTTP_STATUS.FOUND);

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
  expect(submit.status).toBe(HTTP_STATUS.OK);
  const { redirect_url } = (await submit.json()) as { redirect_url: string };
  return { next: new URL(redirect_url), pkce };
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

const idTokenFor = async (code: string, verifier: string) => {
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: LOGIN_CLIENT.clientId,
      code_verifier: verifier,
    }),
  });
  expect(res.status).toBe(HTTP_STATUS.OK);
  return decodeJwt(((await res.json()) as { id_token: string }).id_token);
};

/** A password-only login through to a code; the jar keeps the SSO session. */
const passwordLogin = async (
  jar: CookieJar,
  user: { email: string; plainPassword: string },
  acrValues?: string
) => {
  const { next, pkce } = await submitLogin(jar, user, acrValues);
  // Core's own login client skips consent: the code comes with the login.
  const done = next.searchParams.has("code")
    ? next
    : await post(jar, "/oauth/consent", {
        session_token: next.searchParams.get("session"),
        approved: true,
      });
  return { code: done.searchParams.get("code")!, verifier: pkce.verifier };
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

const silentAuthorize = (jar: CookieJar, acrValues?: string) => {
  const { params } = authorizeParams(acrValues, { prompt: "none" });
  return fetch(`${BASE_URL}/oauth/authorize?${new URLSearchParams(params)}`, {
    redirect: "manual",
    headers: { Cookie: cookieHeader(jar) },
  });
};

describe("acr_values=urn:auth-service:mfa", () => {
  it("sends a user without TOTP through 2FA setup", async () => {
    const user = await createTestUser();
    const { next } = await submitLogin(new Map(), user, MFA);
    expect(next.pathname).toMatch(/\/login\/2fa\/setup$/);
    expect(next.searchParams.get("acr_values")).toBe(MFA);
  });

  it("answers unmet_authentication_requirements when enrolment is disabled", async () => {
    await setPolicy("disabled");
    const user = await createTestUser();
    const { next } = await submitLogin(new Map(), user, MFA);
    expect(`${next.origin}${next.pathname}`).toBe(redirectUri);
    expect(next.searchParams.get("error")).toBe(
      "unmet_authentication_requirements"
    );
  });

  it("asks a user with TOTP for the code, and the ID token says mfa", async () => {
    const user = await createTotpUser();
    const jar: CookieJar = new Map();
    const { next, pkce } = await submitLogin(jar, user, MFA);
    expect(next.pathname).toMatch(/\/login\/2fa$/);

    const done = await post(jar, "/oauth/totp/verify", {
      session_token: next.searchParams.get("session"),
      totp_code: generateTotpCode(user.secret),
    });
    const idToken = await idTokenFor(
      done.searchParams.get("code")!,
      pkce.verifier
    );
    expect(idToken.acr).toBe(MFA);

    // The MFA session satisfies a silent request for MFA.
    const silent = await silentAuthorize(jar, MFA);
    expect(silent.status).toBe(HTTP_STATUS.FOUND);
    const location = new URL(silent.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBeNull();
    expect(location.searchParams.get("code")).toBeTruthy();
  });

  it("answers a silent request over a password-only session with interaction_required", async () => {
    const user = await createTestUser();
    const jar: CookieJar = new Map();
    const { code, verifier } = await passwordLogin(jar, user);
    expect((await idTokenFor(code, verifier)).acr).toBe(PWD);

    const silent = await silentAuthorize(jar, MFA);
    expect(silent.status).toBe(HTTP_STATUS.FOUND);
    const location = new URL(silent.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("interaction_required");
    expect(location.searchParams.get("code")).toBeNull();

    // Without acr_values the same session is enough.
    const plain = new URL(
      (await silentAuthorize(jar)).headers.get("location") ?? ""
    );
    expect(plain.searchParams.get("code")).toBeTruthy();
  });

  it("is not demanded when the password class is acceptable too", async () => {
    const user = await createTestUser();
    const { code, verifier } = await passwordLogin(
      new Map(),
      user,
      `${MFA} ${PWD}`
    );
    expect((await idTokenFor(code, verifier)).acr).toBe(PWD);
  });
});
