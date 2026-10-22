import { ALL_CORE_SCOPES, BASE_URL, HTTP_STATUS } from "./constants.js";
import { LOGIN_CLIENT } from "../../../definitions/index.js";
import { prisma } from "../../../utils/db/prisma.js";
import { TokenResponse } from "./tokens.js";
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateUniqueId,
} from "./crypto.js";

interface AuthorizeResponse {
  redirect_url?: string;
  error?: string;
  error_description?: string;
}

interface ConsentResponse {
  redirect_url?: string;
  error?: string;
  error_description?: string;
}

// Get access token for a user (simulates login flow)
/**
 * An access token issued to core's own UI, from a login that just happened:
 * what the routes behind requireCoreUi and requireRecentLogin accept.
 */
export async function getUiAccessTokenForUser(user: {
  id: string;
  email: string;
  plainPassword: string;
}): Promise<string> {
  const client = await prisma.oAuthClient.findFirstOrThrow({
    where: { clientId: LOGIN_CLIENT.clientId },
    select: { id: true, clientId: true, redirectUris: true },
  });
  return getAccessTokenForUser(user, client, "openid profile email");
}

export async function getAccessTokenForUser(
  user: { id: string; email: string; plainPassword: string },
  client: { clientId: string; id: string; redirectUris?: string[] },
  scope: string = ["openid profile email", ...ALL_CORE_SCOPES].join(" ")
): Promise<string> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateUniqueId();
  const redirectUri =
    client.redirectUris?.[0] || "http://localhost:3000/callback";

  // Step 1: GET /oauth/authorize to get session cookie
  const authorizeUrl = new URL(`${BASE_URL}/oauth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", client.clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("scope", scope);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const getResponse = await fetch(authorizeUrl.toString(), {
    method: "GET",
    redirect: "manual",
  });

  // Extract the session cookie from the GET response
  // Cookie name is tereo_session_{clientId}
  const setCookieHeader = getResponse.headers.get("set-cookie") || "";
  const sessionCookieMatch = setCookieHeader.match(
    /tereo_session_[^=]+=([^;]+)/
  );
  const sessionCookie = sessionCookieMatch ? sessionCookieMatch[0] : "";

  if (!sessionCookie) {
    throw new Error(
      `Failed to get session cookie from authorize GET. Response status: ${getResponse.status}, Headers: ${setCookieHeader}`
    );
  }

  // Step 2: POST credentials with the session cookie
  const authResponse = await fetch(`${BASE_URL}/oauth/authorize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
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
    redirect: "manual",
  });

  const authData = (await authResponse.json()) as AuthorizeResponse;

  if (authData.error) {
    throw new Error(
      `Authorization failed: ${authData.error} - ${authData.error_description}`
    );
  }

  if (!authData.redirect_url) {
    throw new Error("No redirect_url in authorization response");
  }

  let authCode: string | null = null;

  // Check if we have a code in the redirect URL
  if (authData.redirect_url.includes("code=")) {
    const url = new URL(authData.redirect_url);
    authCode = url.searchParams.get("code");
  } else if (authData.redirect_url.includes("/consent")) {
    // Need to handle consent - extract session and approve
    const consentUrl = new URL(authData.redirect_url);
    const consentSessionId = consentUrl.searchParams.get("session");

    if (!consentSessionId) {
      throw new Error("No session in consent redirect URL");
    }

    // Extract consent cookie from auth response
    // Cookie name is tereo_consent_session_{clientId}
    const authCookieHeader = authResponse.headers.get("set-cookie") || "";
    const consentCookieMatch = authCookieHeader.match(
      /tereo_consent_session_[^=]+=([^;]+)/
    );
    const consentCookie = consentCookieMatch ? consentCookieMatch[0] : "";

    const consentResponse = await fetch(`${BASE_URL}/oauth/consent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: consentCookie,
      },
      body: JSON.stringify({
        session_token: consentSessionId,
        approved: true,
      }),
      redirect: "manual",
    });

    const consentData = (await consentResponse.json()) as ConsentResponse;

    if (consentData.error) {
      throw new Error(
        `Consent failed: ${consentData.error} - ${consentData.error_description}`
      );
    }

    if (
      consentData.redirect_url &&
      consentData.redirect_url.includes("code=")
    ) {
      const url = new URL(consentData.redirect_url);
      authCode = url.searchParams.get("code");
    }
  }

  if (!authCode) {
    throw new Error(
      `Failed to obtain authorization code. Auth redirect: ${authData.redirect_url}`
    );
  }

  // Step 3: Exchange code for token
  const tokenResponse = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      code_verifier: codeVerifier,
    }),
  });

  const tokenData = (await tokenResponse.json()) as TokenResponse;

  if (!tokenData.access_token) {
    throw new Error(
      `Failed to obtain access token: ${JSON.stringify(tokenData)}`
    );
  }

  return tokenData.access_token;
}

// Resolve a user's permission live via /oauth/check-permission (client
// credentials over Basic auth). Unlike a minted access token — which embeds
// permissions at issue time — this reflects the current DB state.
export async function checkUserPermission(
  client: { clientId: string; plainSecret: string | null },
  userId: string,
  permission: string
): Promise<boolean> {
  const header = `Basic ${Buffer.from(
    `${client.clientId}:${client.plainSecret}`
  ).toString("base64")}`;

  const response = await fetch(`${BASE_URL}/oauth/check-permission`, {
    method: "POST",
    headers: { Authorization: header, "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, permission }),
  });

  if (response.status !== HTTP_STATUS.OK) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      `check-permission failed: ${response.status} ${JSON.stringify(data)}`
    );
  }

  const data = (await response.json()) as { granted: boolean };
  return data.granted;
}
