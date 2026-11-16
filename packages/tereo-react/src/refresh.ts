import { clearSignedIn, isLoggedOut, markLoggedOut } from "./markers.js";
import { withStorageLock } from "./storageLock.js";
import axios, { isAxiosError } from "axios";
import { activeConfig } from "./config.js";
import {
  type StoredTokens,
  decodeJwt,
  readTokens,
  writeTokens,
} from "./tokens.js";

type TokenResponse = Omit<StoredTokens, "expiresAt">;

/**
 * Core refused the refresh token (400 invalid_grant, 401 invalid_client):
 * the session is over. Anything else (offline, 429, 5xx) may pass, so the
 * stored tokens are kept for the next attempt.
 */
export const isRefreshRejected = (error: unknown): boolean => {
  const status = isAxiosError(error) ? error.response?.status : undefined;
  return status === 400 || status === 401;
};

const subjectOf = (accessToken: string | undefined): string | null => {
  const sub = accessToken ? decodeJwt(accessToken)?.sub : null;
  return typeof sub === "string" ? sub : null;
};

const requestRefresh = async (): Promise<StoredTokens> => {
  const { coreUrl, clientId, requestTimeoutMs } = activeConfig();
  // Who the tab is signed in as; nobody on a load with no stored token.
  const signedInAs = subjectOf(readTokens()?.access_token);

  const res = await axios.post<TokenResponse>(
    `${coreUrl}/oauth/token`,
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token_response_mode: "cookie",
    }),
    {
      withCredentials: true,
      timeout: requestTimeoutMs,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }
  );

  // Signed out in another tab while this refresh was in flight.
  if (isLoggedOut()) throw new Error("Signed out during token refresh");

  // The refresh cookie is not this user's: something outside the app put it
  // there. Marked signed out so that it is not refreshed from again.
  if (signedInAs && subjectOf(res.data.access_token) !== signedInAs) {
    markLoggedOut();
    writeTokens(null);
    throw new Error("Token refresh answered for another user");
  }

  // A refresh returns a fresh id_token for the same login, which sign-out
  // sends as the end-session id_token_hint; keep the stored one if not.
  const idToken = res.data.id_token ?? readTokens()?.id_token;
  const tokens: StoredTokens = {
    ...res.data,
    ...(idToken && { id_token: idToken }),
    expiresAt: Date.now() + res.data.expires_in * 1000,
  };
  writeTokens(tokens);
  return tokens;
};

const refreshAcrossTabs = (): Promise<StoredTokens> => {
  const { clientId, tokenExpirationBuffer } = activeConfig();
  const lockName = `tereo_refresh_${clientId}`;
  const staleToken = readTokens()?.access_token;

  const run = async (): Promise<StoredTokens> => {
    // Another tab may have refreshed while this one waited for the lock.
    // Signed out in another tab while this one waited for the lock.
    if (isLoggedOut()) throw new Error("Signed out");
    const stored = readTokens();
    if (
      stored &&
      stored.access_token !== staleToken &&
      Date.now() < stored.expiresAt - tokenExpirationBuffer
    ) {
      return stored;
    }
    return requestRefresh();
  };

  // navigator.locks is missing outside secure contexts (plain-http hosts).
  return typeof navigator.locks?.request === "function"
    ? navigator.locks.request(lockName, run)
    : withStorageLock(lockName, run);
};

let inFlight: Promise<StoredTokens> | null = null;

/**
 * One refresh at a time, across every tab. Tabs share the rotating refresh
 * cookie: two concurrent refreshes get invalid_grant for the loser, and a
 * request still carrying the pre-rotation cookie is treated by core as token
 * reuse, which revokes the whole family.
 */
export const refreshTokens = (): Promise<StoredTokens> => {
  inFlight ??= refreshAcrossTabs()
    .catch((error: unknown) => {
      if (isRefreshRejected(error)) {
        writeTokens(null);
        clearSignedIn();
      }
      throw error;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
};
