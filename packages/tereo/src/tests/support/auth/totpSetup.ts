import { createTestRole, createTestUser } from "./users.js";
import { prisma } from "../../../utils/db/prisma.js";
import { BASE_URL } from "./constants.js";
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateUniqueId,
} from "./crypto.js";

// A user without TOTP holding a role that requires it, so the password step
// of /oauth/authorize sends them to 2FA setup.
export async function createUserRequiringTotpSetup() {
  const user = await createTestUser();
  const role = await createTestRole();
  await prisma.role.update({
    where: { id: role.id },
    data: { requires2fa: true },
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return user;
}

export interface TotpSetupGrantLogin {
  setupUrl: URL;
  setupGrant: string;
  // `name=value` for the Cookie header
  grantCookie: string;
  codeVerifier: string;
  state: string;
}

// Drives GET + POST /oauth/authorize up to the redirect to 2FA setup.
export async function loginToTotpSetup(
  user: { email: string; plainPassword: string },
  client: { clientId: string; redirectUris?: string[] },
  scope: string = "openid profile email"
): Promise<TotpSetupGrantLogin> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateUniqueId();
  const redirectUri =
    client.redirectUris?.[0] || "http://localhost:3000/callback";

  const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", client.clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("scope", scope);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const getResponse = await fetch(authorizeUrl.toString(), {
    redirect: "manual",
  });
  const sessionCookie =
    (getResponse.headers.get("set-cookie") || "").match(
      /tereo_session_[^=]+=[^;]+/
    )?.[0] ?? "";

  const authResponse = await fetch(`${BASE_URL}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: sessionCookie },
    body: JSON.stringify({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: redirectUri,
      state,
      scope,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      email: user.email,
      password: user.plainPassword,
    }),
  });
  const authData = (await authResponse.json()) as { redirect_url?: string };
  if (!authData.redirect_url?.includes("/login/2fa/setup")) {
    throw new Error(
      `Expected a redirect to 2FA setup, got ${JSON.stringify(authData)}`
    );
  }

  const setupUrl = new URL(authData.redirect_url);
  const grantCookie =
    (authResponse.headers.get("set-cookie") || "").match(
      /tereo_2fa_setup_grant_[^=]+=[^;]+/
    )?.[0] ?? "";

  return {
    setupUrl,
    setupGrant: setupUrl.searchParams.get("setup_grant") ?? "",
    grantCookie,
    codeVerifier,
    state,
  };
}

export function startTotpSetup(
  body: Record<string, unknown>,
  cookie?: string
): Promise<Response> {
  return fetch(`${BASE_URL}/oauth/totp/setup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}
