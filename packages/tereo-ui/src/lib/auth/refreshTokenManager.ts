import { readStoredTokens } from "./logoutMarker";
import { withStorageLock } from "./storageLock";
import type { StoredTokens } from "./types";
import { isAxiosError } from "axios";
import env from "./config";

const REFRESH_LOCK = "tereo_refresh";

/**
 * Core refused the refresh token (400 invalid_grant, 401 invalid_client):
 * the session is over. Anything else (offline, 429, 5xx) may pass, so the
 * stored tokens are kept for the next attempt.
 */
export const isRefreshRejected = (error: unknown): boolean => {
  const status = isAxiosError(error) ? error.response?.status : undefined;
  return status === 400 || status === 401;
};

/**
 * One refresh at a time, across every tab. Tabs share the rotating refresh
 * cookie: two concurrent refreshes get invalid_grant for the loser, and a
 * request still carrying the pre-rotation cookie is treated by core as token
 * reuse, which revokes the whole family.
 */
class RefreshTokenManager {
  private refreshPromise: Promise<StoredTokens> | null = null;

  refresh(refreshFn: () => Promise<StoredTokens>): Promise<StoredTokens> {
    this.refreshPromise ??= this.refreshAcrossTabs(refreshFn).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private refreshAcrossTabs(
    refreshFn: () => Promise<StoredTokens>
  ): Promise<StoredTokens> {
    const staleToken = readStoredTokens()?.access_token;

    const run = async () => {
      // Another tab may have refreshed while this one waited for the lock.
      const stored = readStoredTokens();
      if (
        stored &&
        stored.access_token !== staleToken &&
        Date.now() < stored.expiresAt - env.tokenExpirationBuffer
      ) {
        return stored;
      }
      return refreshFn();
    };

    // navigator.locks is missing outside secure contexts (plain-http hosts).
    return typeof navigator.locks?.request === "function"
      ? navigator.locks.request(REFRESH_LOCK, run)
      : withStorageLock(REFRESH_LOCK, run);
  }
}

export const refreshTokenManager = new RefreshTokenManager();
