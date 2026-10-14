import env from "./config";

export interface PKCEChallenge {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
  nonce: string;
}

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

const generatePKCEChallenge = async (): Promise<PKCEChallenge> => {
  const codeVerifier = generateRandomString(64);
  return {
    codeVerifier,
    codeChallenge: await generateCodeChallenge(codeVerifier),
    state: generateRandomString(32),
    nonce: generateRandomString(32),
  };
};

// sessionStorage, not localStorage: the flow stays in one tab, and a login
// started in a second tab must not overwrite this tab's verifier and state.
const savePKCE = (challenge: PKCEChallenge): void => {
  sessionStorage.setItem(env.PKCE_KEY, JSON.stringify(challenge));
};

export const readPKCE = (): PKCEChallenge | null => {
  try {
    const raw = sessionStorage.getItem(env.PKCE_KEY);
    return raw ? (JSON.parse(raw) as PKCEChallenge) : null;
  } catch {
    return null;
  }
};

export const clearPKCE = (): void => {
  try {
    sessionStorage.removeItem(env.PKCE_KEY);
  } catch {
    // Nothing stored to clear.
  }
};

const POST_LOGIN_KEY = "tereo_post_login_path";

/** An in-app path only: never a full URL, which would be an open redirect. */
const isAppPath = (path: string): boolean =>
  path.startsWith("/") && !path.startsWith("//") && !path.includes("\\");

/** The path the callback sends the user to once the sign-in completes. */
export const takePostLoginPath = (): string | null => {
  try {
    const path = sessionStorage.getItem(POST_LOGIN_KEY);
    sessionStorage.removeItem(POST_LOGIN_KEY);
    return path && isAppPath(path) ? path : null;
  } catch {
    return null;
  }
};

/**
 * Redirects to core's authorize endpoint with a fresh PKCE challenge.
 * `returnTo` is an in-app path to land on after the callback, instead of "/".
 */
export const startLogin = async (
  extraParams: Record<string, string> = {},
  returnTo?: string
): Promise<void> => {
  if (returnTo && isAppPath(returnTo)) {
    try {
      sessionStorage.setItem(POST_LOGIN_KEY, returnTo);
    } catch {
      // The sign-in still works; it lands on "/".
    }
  }
  const challenge = await generatePKCEChallenge();
  savePKCE(challenge);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.CLIENT_ID,
    redirect_uri: env.REDIRECT_URI,
    state: challenge.state,
    nonce: challenge.nonce,
    code_challenge: challenge.codeChallenge,
    code_challenge_method: "S256",
    scope: "openid profile email offline_access",
    ...extraParams,
  });

  window.location.href = `${env.AUTH_SERVER_URL}/oauth/authorize?${params}`;
};
