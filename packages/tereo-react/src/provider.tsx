import { type PermissionRequirement, hasPermission } from "./permissions.js";
import { type StoredTokens, decodeJwt, readTokens } from "./tokens.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type EventSocket, startTereoEvents } from "./events.js";
import { type AxiosInstance, isAxiosError } from "axios";
import { endLocalSession, signOut } from "./signOut.js";
import { useStoredValue } from "./storage.js";
import { refreshTokens } from "./refresh.js";
import { createApiClients } from "./api.js";
import { hasSession } from "./markers.js";
import { debugLog } from "./logger.js";
import { io } from "socket.io-client";
import { signIn } from "./signIn.js";
import {
  type ResolvedConfig,
  type TereoAuthConfig,
  type TereoEvent,
  type TereoUser,
  pathWithoutBase,
  resolveConfig,
  setActiveConfig,
} from "./config.js";
import {
  type ReactNode,
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export interface AuthState<U extends TereoUser = TereoUser> {
  user: U | null;
  isLoading: boolean;
  isSignedIn: boolean;
  /** Whether core's live-update socket is connected. */
  isLive: boolean;
  hasPermission: (required: PermissionRequirement) => boolean;
  signIn: typeof signIn;
  signOut: typeof signOut;
  switchOrganization: (orgId: string) => Promise<void>;
  reloadUser: () => Promise<void>;
}

export interface ApiClients {
  authed: Record<string, AxiosInstance>;
  open: Record<string, AxiosInstance>;
}

export const AuthContext = createContext<AuthState | null>(null);
export const ApiContext = createContext<ApiClients | null>(null);

// Every user cached for this client; one identity's entry is that prefix
// plus its subject and organization.
const usersKey = (clientId: string) => ["tereo", "user", clientId] as const;

const claimOf = (token: string | undefined, claim: string): string | null => {
  const value = token ? decodeJwt(token)?.[claim] : null;
  return typeof value === "string" ? value : null;
};

// A user lookup core refused for the token is not retried; other failures
// (network, 5xx) are, twice, with backoff.
const retryUserLookup = (failureCount: number, error: unknown): boolean => {
  const status = isAxiosError(error) ? error.response?.status : undefined;
  if (status === 401 || status === 403) return false;
  return failureCount < 2;
};
const userLookupDelay = (attempt: number): number =>
  Math.min(1000 * 2 ** attempt, 30_000);

// Events that arrive together reload the user once.
const RELOAD_DEBOUNCE_MS = 250;

const currentRoutePath = (config: ResolvedConfig): string =>
  pathWithoutBase(window.location.pathname, config.basePath).replace(
    /(.)\/+$/,
    "$1"
  ) || "/";

/** Needs a `QueryClientProvider` above it. */
export const TereoAuthProvider = ({
  config,
  children,
}: {
  config: TereoAuthConfig;
  children: ReactNode;
}) => {
  // Set during the first render, so hooks and plain functions such as
  // `signIn` work from the start. The config is read once.
  const [resolved] = useState(() => {
    const r = resolveConfig(config);
    setActiveConfig(r);
    return r;
  });
  const { clientId, keys, apis, loadUser } = resolved;

  const queryClient = useQueryClient();
  const clients = useMemo(() => createApiClients(apis), [apis]);
  const tokens = useStoredValue<StoredTokens>(keys.tokens);
  const accessToken = tokens?.access_token;
  // Keyed on whose token it is, so a sign-in as someone else or into
  // another organization (here or in another tab) never reads the previous
  // identity's user.
  const userId = useMemo(() => claimOf(accessToken, "sub"), [accessToken]);
  const orgId = useMemo(() => claimOf(accessToken, "org_id"), [accessToken]);
  const queryKey = useMemo(
    () => [...usersKey(clientId), userId, orgId] as const,
    [clientId, userId, orgId]
  );

  // A page load with a session but no token (the access token lives in
  // storage the tab may not have): renew it before deciding anything.
  const [restoring, setRestoring] = useState(() => !tokens && hasSession());
  useEffect(() => {
    if (tokens || !hasSession()) {
      setRestoring(false);
      return;
    }
    // refreshTokens clears what core rejected; other failures leave the
    // next request to retry.
    void refreshTokens()
      .catch(() => {})
      .finally(() => setRestoring(false));
  }, [tokens]);

  const query = useQuery({
    queryKey,
    queryFn: () => loadUser(clients.authed),
    enabled: tokens !== null,
    retry: retryUserLookup,
    retryDelay: userLookupDelay,
  });

  useEffect(() => {
    // Signed out here or in another tab: drop the cached user rather than
    // render it until the redirect lands.
    if (!tokens) queryClient.removeQueries({ queryKey: usersKey(clientId) });
  }, [tokens, queryClient, clientId]);

  useEffect(() => {
    if (tokens || restoring || hasSession()) return;
    if (resolved.isPublicPath(currentRoutePath(resolved))) return;
    window.location.href = `${resolved.basePath}${resolved.signedOutPath}`;
  }, [tokens, restoring, resolved]);

  const user = tokens ? (query.data ?? null) : null;

  const check = useCallback(
    (required: PermissionRequirement) =>
      hasPermission(user?.permissions ?? [], required),
    [user]
  );
  const switchOrganization = useCallback(
    (orgId: string) => signIn({ params: { org_id: orgId } }),
    []
  );
  const reloadUser = useCallback(
    () => queryClient.invalidateQueries({ queryKey }),
    [queryClient, queryKey]
  );

  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A new token (exchange, refresh, another tab) may carry other
  // permissions. A new identity changes the key, which loads on its own;
  // the same one is reloaded now, which also covers any pending event
  // reload.
  const lastToken = useRef(accessToken);
  const lastKey = useRef(queryKey);
  useEffect(() => {
    const previousToken = lastToken.current;
    const previousKey = lastKey.current;
    lastToken.current = accessToken;
    lastKey.current = queryKey;
    if (!previousToken || !accessToken || previousToken === accessToken) return;
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = null;
    if (previousKey === queryKey)
      void queryClient.invalidateQueries({ queryKey });
  }, [accessToken, queryKey, queryClient]);

  const [isLive, setIsLive] = useState(false);

  // `config` is resolved once, but a callback written inline should see
  // the state of the latest render.
  const onEventRef = useRef(config.onEvent);
  useEffect(() => {
    onEventRef.current = config.onEvent;
  }, [config.onEvent]);

  // The events loop is keyed on the user, not the token: the token (and
  // its sid) rotates on every refresh, and the loop reads the current one
  // at each handshake.
  useEffect(() => {
    if (!resolved.live || !userId) return;

    const handleEvent = (event: TereoEvent) => {
      onEventRef.current?.(event);
      if (event.type === "session-revoked") return;
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => {
        reloadTimer.current = null;
        void reloadUser();
      }, RELOAD_DEBOUNCE_MS);
    };

    // Deferred to a microtask so StrictMode's mount, unmount, mount cancels
    // before a handshake starts.
    let stop: (() => void) | null = null;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      stop = startTereoEvents({
        // socket.io treats a URL's path as a namespace; core serves the
        // socket at `wsPath`, so only the origin goes in the URL.
        createSocket: (auth) => {
          const socket = io(new URL(resolved.coreUrl).origin, {
            path: resolved.wsPath,
            transports: ["websocket", "polling"],
            autoConnect: false,
            auth,
          });
          socket.on("connect", () => setIsLive(true));
          socket.on("disconnect", () => setIsLive(false));
          socket.on("connect_error", () => setIsLive(false));
          return socket as unknown as EventSocket;
        },
        accessToken: () => readTokens()?.access_token ?? null,
        tokenIsFresh: () => {
          const stored = readTokens();
          return (
            !!stored &&
            Date.now() < stored.expiresAt - resolved.tokenExpirationBuffer
          );
        },
        sessionId: () => {
          const token = readTokens()?.access_token;
          const sid = token ? decodeJwt(token)?.sid : null;
          return typeof sid === "string" ? sid : null;
        },
        refresh: refreshTokens,
        // Core already ended the session: a revoke would fail, and an
        // end-session without a usable hint asks the user to confirm.
        sessionEnded: endLocalSession,
        onEvent: handleEvent,
        refused: (reason) => debugLog("Events socket stopped:", reason),
        log: (message, detail) => debugLog(message, detail),
      });
    });

    return () => {
      cancelled = true;
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      reloadTimer.current = null;
      stop?.();
      setIsLive(false);
    };
  }, [userId, resolved, reloadUser]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      isLoading: restoring || query.isLoading || query.isFetching,
      isSignedIn: user !== null,
      isLive,
      hasPermission: check,
      signIn,
      signOut,
      switchOrganization,
      reloadUser,
    }),
    [
      user,
      restoring,
      query.isLoading,
      query.isFetching,
      isLive,
      check,
      switchOrganization,
      reloadUser,
    ]
  );

  return (
    <ApiContext.Provider value={clients}>
      <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
    </ApiContext.Provider>
  );
};
