import { type StoredTokens, decodeJwt, writeTokens } from "./tokens.js";
import { clearLoggedOut, markSignedIn } from "./markers.js";
import { activeConfig } from "./config.js";
import axios from "axios";

interface PKCEChallenge {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
  nonce: string;
}

type TokenResponse = Omit<StoredTokens, "expiresAt">;

const generateRandomString = (length: number): string => {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
};

const generateCodeChallenge = async (codeVerifier: string): Promise<string> => {
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

// sessionStorage, not localStorage: the flow stays in one tab, and a login
// started in a second tab must not overwrite this tab's verifier and state.
const readPKCE = (): PKCEChallenge | null => {
  try {
    const raw = sessionStorage.getItem(activeConfig().keys.pkce);
    return raw ? (JSON.parse(raw) as PKCEChallenge) : null;
  } catch {
    return null;
  }
};

const clearPKCE = (): void => {
  try {
    sessionStorage.removeItem(activeConfig().keys.pkce);
  } catch {
    // Nothing stored to clear.
  }
};

/** An in-app path only: never a full URL, which would be an open redirect. */
const isAppPath = (path: string): boolean =>
  path.startsWith("/") && !path.startsWith("//") && !path.includes("\\");

const takePostLoginPath = (): string | null => {
  const { postLoginPath } = activeConfig().keys;
  try {
    const path = sessionStorage.getItem(postLoginPath);
    sessionStorage.removeItem(postLoginPath);
    return path && isAppPath(path) ? path : null;
  } catch {
    return null;
  }
};

/**
 * Redirects to core's authorize endpoint with a fresh PKCE challenge.
 * `returnTo` is an in-app path to land on after the callback, instead of "/".
 */
export const signIn = async (
  opts: { returnTo?: string; params?: Record<string, string> } = {}
): Promise<void> => {
  const { coreUrl, clientId, redirectUri, scopes, keys } = activeConfig();

  try {
    sessionStorage.removeItem(keys.postLoginPath);
    if (opts.returnTo && isAppPath(opts.returnTo)) {
      sessionStorage.setItem(keys.postLoginPath, opts.returnTo);
    }
  } catch {
    // The sign-in still works; it lands on the default path.
  }

  const codeVerifier = generateRandomString(64);
  const challenge: PKCEChallenge = {
    codeVerifier,
    codeChallenge: await generateCodeChallenge(codeVerifier),
    state: generateRandomString(32),
    nonce: generateRandomString(32),
  };
  sessionStorage.setItem(keys.pkce, JSON.stringify(challenge));

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state: challenge.state,
    nonce: challenge.nonce,
    code_challenge: challenge.codeChallenge,
    code_challenge_method: "S256",
    scope: scopes,
    ...opts.params,
  });

  window.location.href = `${coreUrl}/oauth/authorize?${params}`;
};

/** Finishes the sign-in from the callback's query string. */
export const completeSignIn = async (
  search: URLSearchParams
): Promise<{ returnTo: string | null }> => {
  const { coreUrl, clientId, redirectUri, requestTimeoutMs } = activeConfig();

  const error = search.get("error");
  if (error) throw new Error(error);

  const code = search.get("code");
  const state = search.get("state");
  if (!code || !state) {
    throw new Error("The sign-in response is missing its code or state.");
  }

  const pkce = readPKCE();
  if (!pkce || pkce.state !== state) {
    throw new Error(
      "This sign-in link does not match the one this tab started. Please sign in again."
    );
  }
  // The verifier is single-use: a failed exchange cannot be retried.
  clearPKCE();

  const res = await axios.post<TokenResponse>(
    `${coreUrl}/oauth/token`,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: pkce.codeVerifier,
      refresh_token_response_mode: "cookie",
    }),
    {
      withCredentials: true,
      timeout: requestTimeoutMs,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }
  );

  const tokens = res.data;
  // Received straight from the token endpoint over TLS, so the signature
  // need not be checked (OIDC Core 3.1.3.7); the nonce and audience must.
  const idToken = tokens.id_token ? decodeJwt(tokens.id_token) : null;
  if (!idToken || idToken.nonce !== pkce.nonce) {
    throw new Error("ID token nonce validation failed");
  }
  if (idToken.aud !== clientId) {
    throw new Error("ID token was issued to a different client");
  }

  writeTokens({ ...tokens, expiresAt: Date.now() + tokens.expires_in * 1000 });
  markSignedIn();
  clearLoggedOut();
  return { returnTo: takePostLoginPath() };
};
