import type { StoredTokens } from "./types";
import env from "./config";

// Set by an explicit sign-out and cleared only by the next interactive login
// (the code exchange). While it is set the session-indicator cookie is
// ignored: if the revoke call failed, the refresh cookie may still be valid,
// and a silent refresh would sign the user straight back in.
export const markLoggedOut = (): void => {
  try {
    localStorage.setItem(env.LOGGED_OUT_KEY, "1");
  } catch {
    // Storage unavailable: there are no stored tokens to refresh into either.
  }
};

export const clearLoggedOut = (): void => {
  try {
    localStorage.removeItem(env.LOGGED_OUT_KEY);
  } catch {
    // See markLoggedOut.
  }
};

export const isLoggedOut = (): boolean => {
  try {
    return localStorage.getItem(env.LOGGED_OUT_KEY) !== null;
  } catch {
    return false;
  }
};

// Read from storage rather than hook state: mutation closures can hold a
// stale render's value.
export const readStoredTokens = (): StoredTokens | null => {
  try {
    const raw = localStorage.getItem(env.TOKEN_KEY);
    return raw ? (JSON.parse(raw) as StoredTokens) : null;
  } catch {
    return null;
  }
};
