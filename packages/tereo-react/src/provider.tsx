import { type PermissionRequirement, hasPermission } from "./permissions.js";
import { type StoredTokens, decodeJwt, readTokens } from "./tokens.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type EventSocket, startTereoEvents } from "./events.js";
import { useStoredValue } from "./storage.js";
import { refreshTokens } from "./refresh.js";
import { createApiClients } from "./api.js";
import type { AxiosInstance } from "axios";
import { hasSession } from "./markers.js";
import { debugLog } from "./logger.js";
import { signOut } from "./signOut.js";
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

const userKey = (clientId: string) => ["tereo", "user", clientId] as const;

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
  const queryKey = useMemo(() => userKey(clientId), [clientId]);

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
  });

  useEffect(() => {
    // Signed out here or in another tab: drop the cached user rather than
    // render it until the redirect lands.
    if (!tokens) queryClient.removeQueries({ queryKey });
  }, [tokens, queryClient, queryKey]);

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

  // Keyed on the user, not the token: the token (and its sid) rotates on
  // every refresh, and the events loop reads the current one at each
  // handshake.
  const accessToken = tokens?.access_token;
  const userId = useMemo(() => {
    const sub = accessToken ? decodeJwt(accessToken)?.sub : null;
    return typeof sub === "string" ? sub : null;
  }, [accessToken]);

  const [isLive, setIsLive] = useState(false);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    },
    []
  );

  useEffect(() => {
    if (!resolved.live || !userId) return;

    const handleEvent = (event: TereoEvent) => {
      resolved.onEvent?.(event);
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
        signOut: () => void signOut(),
        onEvent: handleEvent,
        refused: (reason) => debugLog("Events socket stopped:", reason),
        log: (message, detail) => debugLog(message, detail),
      });
    });

    return () => {
      cancelled = true;
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
