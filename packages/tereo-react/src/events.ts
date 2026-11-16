import { isRefreshRejected } from "./refresh.js";
import type { TereoEvent } from "./config.js";

/** The slice of a socket.io client socket the live-updates loop uses. */
export interface EventSocket {
  readonly active: boolean;
  connect(): void;
  disconnect(): void;
  on(event: string, listener: (...args: never[]) => void): void;
}

export type SocketAuth = (cb: (data: { token?: string }) => void) => void;

export interface TereoEventsDeps {
  /** Builds the socket, not yet connected; `auth` is read at each connect. */
  createSocket: (auth: SocketAuth) => EventSocket;
  /** The stored access token, or null when signed out. */
  accessToken: () => string | null;
  /** Whether the stored token is still good for a handshake. */
  tokenIsFresh: () => boolean;
  /** The current token's session (`sid`, the refresh token's id). */
  sessionId: () => string | null;
  /**
   * Refreshes the token; a refusal clears it, which signs the user out. Must
   * make the new token what `accessToken()` returns before it resolves.
   */
  refresh: () => Promise<unknown>;
  /** Core revoked this session; it is already over server-side. */
  sessionEnded: () => void;
  /** Every event core sends, including revocations of the user's other sessions. */
  onEvent: (event: TereoEvent) => void;
  /**
   * Core will not admit this session's token: the login client lacks
   * `liveEvents`, or core refused the handshake again after a refresh. The
   * loop stops until the user signs in again.
   */
  refused?: (reason: string) => void;
  /** Defaults to setTimeout; returns a cancel function. */
  schedule?: (fn: () => void, ms: number) => () => void;
  log?: (message: string, detail?: unknown) => void;
}

// Handshake refusals that say nothing about the token (core's
// websocket/index.ts); any other refusal is about the token.
const TRANSIENT_REFUSALS = new Set([
  "Too many connections",
  "Server is shutting down",
]);

// Refusals no new token can change: the login client is not admitted to
// live events, or the token is a client's own.
const FINAL_REFUSALS = new Set([
  "This token is not issued for core's API",
  "Invalid token subject",
]);

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 60_000;

const defaultSchedule = (fn: () => void, ms: number) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

/**
 * Core's `/ws` events for the signed-in user. Core authenticates a socket
 * once, at the handshake, and closes it when its token expires or is
 * revoked; socket.io does not reconnect after a server-side close or a
 * handshake the server refused, so this does, with a fresh token. Returns a
 * stop function.
 */
export const startTereoEvents = (deps: TereoEventsDeps): (() => void) => {
  const schedule = deps.schedule ?? defaultSchedule;
  const log = deps.log ?? (() => {});
  let stopped = false;
  let signedOut = false;
  let retryMs = RETRY_MIN_MS;
  // A token refusal is answered with one refresh; a second refusal stops.
  let refreshedForRefusal = false;
  let cancelRetry: (() => void) | null = null;

  const socket = deps.createSocket((cb) =>
    cb({ token: deps.accessToken() ?? undefined })
  );

  const signOut = () => {
    if (signedOut) return;
    signedOut = true;
    deps.sessionEnded();
  };

  // "transient" when core did not answer the refresh (offline, timeout,
  // 5xx); a refusal clears the token, which signs the user out.
  const refresh = async (): Promise<"ok" | "rejected" | "transient"> => {
    try {
      await deps.refresh();
      return "ok";
    } catch (error) {
      log("Token refresh for the events socket failed", error);
      return isRefreshRejected(error) ? "rejected" : "transient";
    }
  };

  const connectFresh = async () => {
    if (stopped || !deps.accessToken()) return;
    if (!deps.tokenIsFresh()) {
      const outcome = await refresh();
      if (outcome === "transient") retryLater();
      if (outcome !== "ok") return;
    }
    if (!stopped && deps.accessToken()) socket.connect();
  };

  const retryLater = () => {
    if (stopped || cancelRetry) return;
    const delay = retryMs;
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    cancelRetry = schedule(() => {
      cancelRetry = null;
      void connectFresh();
    }, delay);
  };

  socket.on("connect", () => {
    retryMs = RETRY_MIN_MS;
    refreshedForRefusal = false;
  });
  socket.on("disconnect", (reason: string) => {
    log("Events socket closed", reason);
    if (reason === "io server disconnect") void connectFresh();
  });
  socket.on("connect_error", (error: Error) => {
    log("Events socket refused", error.message);
    // Still active: socket.io retries by itself (a network error).
    if (socket.active || stopped) return;
    if (TRANSIENT_REFUSALS.has(error.message)) {
      retryLater();
      return;
    }
    if (FINAL_REFUSALS.has(error.message) || refreshedForRefusal) {
      deps.refused?.(error.message);
      return;
    }
    refreshedForRefusal = true;
    void refresh().then((outcome) => {
      if (outcome === "transient") {
        // No new token yet: the next refusal still earns a refresh.
        refreshedForRefusal = false;
        retryLater();
      } else if (outcome === "ok" && !stopped && deps.accessToken()) {
        socket.connect();
      }
    });
  });
  socket.on(
    "auth:permissions:changed",
    (payload: { reason: string; timestamp: number }) =>
      deps.onEvent({ type: "permissions", payload })
  );
  socket.on(
    "auth:organization:changed",
    (payload: { reason: string; organizationId?: string; timestamp: number }) =>
      deps.onEvent({ type: "organization", payload })
  );
  socket.on(
    "auth:session:revoked",
    (payload: { sessionId: string; timestamp: number }) => {
      deps.onEvent({ type: "session-revoked", payload });
      // Sent for each of the user's revoked sessions; only ours signs out.
      if (payload?.sessionId && payload.sessionId === deps.sessionId()) {
        signOut();
      }
    }
  );

  void connectFresh();

  return () => {
    stopped = true;
    cancelRetry?.();
    cancelRetry = null;
    socket.disconnect();
  };
};
