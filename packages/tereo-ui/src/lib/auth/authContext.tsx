import { AuthContext, type AuthContextValue } from "./authContextValue";
import { refreshTokenManager } from "./refreshTokenManager";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalStorage } from "@kosmeo-ui/react";
import { io, type Socket } from "socket.io-client";
import { readStoredTokens } from "./logoutMarker";
import useRefreshToken from "./useRefreshToken";
import { debugLog, errorLog } from "./logger";
import { decodeAccessToken } from "./jwt";
import useUserInfo from "./useUserInfo";
import { startLogin } from "./pkce";
import env from "./config";
import {
  hasPermission as checkPermission,
  type PermissionRequirement,
} from "./permissions";
import type {
  StoredTokens,
  PermissionChangePayload,
  SessionRevokedPayload,
} from "./types";
import {
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider = ({ children }: AuthProviderProps) => {
  const [tokens, setTokens] = useLocalStorage<StoredTokens>(env.TOKEN_KEY);
  const [isSocketConnected, setIsSocketConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const queryClient = useQueryClient();

  const { mutateAsync: refreshToken } = useRefreshToken();
  const { data: userInfo, isLoading, isFetching } = useUserInfo();

  const logout = useCallback(() => {
    setTokens(null);
    window.location.href = env.logoutRedirectPath;
  }, [setTokens]);

  const hasPermission = useCallback(
    (required: PermissionRequirement): boolean => {
      const permissions = userInfo?.permissions ?? [];
      const anyOf = typeof required === "string" ? [required] : required;
      return anyOf.some((p) => checkPermission(permissions, p));
    },
    [userInfo]
  );

  const currentOrganization = useMemo(() => {
    if (!userInfo?.org_id || !userInfo.organizations) return null;
    return (
      userInfo.organizations.find((o) => String(o.id) === userInfo.org_id) ??
      null
    );
  }, [userInfo]);

  const organizations = useMemo(() => {
    return userInfo?.organizations ?? [];
  }, [userInfo]);

  const switchOrganization = useCallback(
    (orgId: string) => startLogin({ org_id: orgId }),
    []
  );

  const logoutRef = useRef(logout);
  const refreshTokenRef = useRef(refreshToken);
  const queryClientRef = useRef(queryClient);
  const accessTokenRef = useRef(tokens?.access_token);

  useEffect(() => {
    logoutRef.current = logout;
    refreshTokenRef.current = refreshToken;
    queryClientRef.current = queryClient;
    accessTokenRef.current = tokens?.access_token;
  }, [logout, refreshToken, queryClient, tokens?.access_token]);

  const handlePermissionChange = useCallback(
    async (_payload: PermissionChangePayload) => {
      debugLog("Permissions changed, refreshing token");
      // A rejected refresh clears the tokens (useRefreshToken), which signs
      // the user out; any other failure leaves the next request to retry.
      await refreshTokenManager
        .refresh(refreshTokenRef.current)
        .catch((error) =>
          errorLog("Failed to refresh token after permission change:", error)
        );
    },
    []
  );

  const handleSessionRevoked = useCallback((payload: SessionRevokedPayload) => {
    const currentSessionId = accessTokenRef.current
      ? decodeAccessToken(accessTokenRef.current)?.sid
      : null;

    if (currentSessionId === payload.sessionId) {
      logoutRef.current();
      return;
    }

    queryClientRef.current.invalidateQueries({ queryKey: ["sessions"] });
    queryClientRef.current.invalidateQueries({
      queryKey: ["account", "sessions"],
    });
  }, []);

  useEffect(() => {
    // Signed out (here or in another tab): drop the cached user so the UI
    // does not keep rendering it until the redirect below lands.
    if (!tokens) queryClient.removeQueries({ queryKey: ["userInfo"] });
  }, [tokens, queryClient]);

  useEffect(() => {
    // Route paths, without the base path and any trailing slash.
    const routePath = (p: string) =>
      (p.startsWith(env.basePath) ? p.slice(env.basePath.length) : p).replace(
        /(.)\/+$/,
        "$1"
      ) || "/";
    const path = routePath(window.location.pathname);

    if (
      path.startsWith("/callback") ||
      path.startsWith("/setup") ||
      path.startsWith("/consent") ||
      path === routePath(env.unauthorizedRedirectPath) ||
      path.startsWith("/login") ||
      path.startsWith("/logout") ||
      // Public share-unlock page — recipients of a password-protected
      // share link are typically external users with no account.
      path.startsWith("/shared/") ||
      tokens
    ) {
      return;
    } else window.location.href = env.unauthorizedRedirectPath;
  }, [tokens]);

  // Keyed on the user, not the token: the token (and its sid) rotates on every
  // refresh, and core closes the socket when the token it connected with
  // expires. `auth` is a callback so a reconnect hands over the current
  // token, not the first one.
  const userId = tokens?.access_token
    ? (decodeAccessToken(tokens.access_token)?.sub ?? null)
    : null;

  useEffect(() => {
    if (userId == null) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        setIsSocketConnected(false);
      }
      return;
    }

    // Defer socket creation to a microtask so React 18 StrictMode's
    // synchronous double-invocation (mount → unmount → mount, in dev) can
    // cancel before the WS handshake starts. Without this, the first pass
    // opens a socket that gets disconnected mid-handshake, producing a
    // "WebSocket is closed before the connection is established" warning.
    let socket: Socket | null = null;
    let cancelled = false;

    const reconnectFresh = async () => {
      const stored = readStoredTokens();
      if (!stored) return;
      try {
        // A token at or near expiry is replaced first; a revoked one is
        // too, as the refresh fails and signs the user out.
        const current =
          Date.now() < stored.expiresAt - env.tokenExpirationBuffer
            ? stored
            : await refreshTokenManager.refresh(refreshTokenRef.current);
        accessTokenRef.current = current.access_token;
      } catch (error) {
        errorLog("Failed to refresh token for WebSocket reconnect:", error);
        return;
      }
      if (!cancelled) socket?.connect();
    };

    Promise.resolve().then(() => {
      if (cancelled) return;

      // socket.io treats the URL's pathname as a namespace, so pass only the
      // origin here; core serves the socket at `wsPath` (/ws).
      socket = io(new URL(env.AUTH_SERVER_URL).origin, {
        path: env.wsPath,
        transports: ["websocket", "polling"],
        auth: (cb) => cb({ token: accessTokenRef.current }),
      });

      socket.on("connect", () => {
        debugLog("Auth WebSocket connected");
        setIsSocketConnected(true);
      });

      socket.on("disconnect", (reason) => {
        debugLog("Auth WebSocket disconnected:", reason);
        setIsSocketConnected(false);
        // Core closes the socket when its token expires or is revoked, and
        // socket.io does not reconnect after a server-side close. Reconnect
        // with a fresh token; a refresh core rejects signs the user out
        // (useRefreshToken), which tears this socket down instead.
        if (reason === "io server disconnect") void reconnectFresh();
      });

      socket.on("connect_error", (error) => {
        errorLog("Auth WebSocket connection error:", error.message);
        setIsSocketConnected(false);
      });

      socket.on("auth:permissions:changed", handlePermissionChange);
      socket.on("auth:session:revoked", handleSessionRevoked);
      socket.on("auth:organization:changed", handlePermissionChange);

      socketRef.current = socket;
    });

    return () => {
      cancelled = true;
      if (socket) {
        socket.off("auth:permissions:changed", handlePermissionChange);
        socket.off("auth:session:revoked", handleSessionRevoked);
        socket.off("auth:organization:changed", handlePermissionChange);
        socket.disconnect();
        socketRef.current = null;
      }
    };
  }, [userId, handlePermissionChange, handleSessionRevoked]);

  const value: AuthContextValue = useMemo(
    () => ({
      user: userInfo || null,
      isLoading: isLoading || isFetching,
      isSocketConnected,
      hasPermission,
      currentOrganization,
      organizations,
      switchOrganization,
    }),
    [
      hasPermission,
      userInfo,
      isLoading,
      isFetching,
      isSocketConnected,
      currentOrganization,
      organizations,
      switchOrganization,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

/**
 * Hook to access authentication state and utilities.
 *
 * Must be used within an `<AuthProvider>` component.
 *
 * @returns {AuthContextValue} Authentication context containing:
 *   - `user`: Current user information or null if not authenticated
 *   - `isLoading`: True while fetching user info
 *   - `isSocketConnected`: WebSocket connection status for real-time updates
 *   - `hasPermission`: Function to check if user has a permission, or any of a list
 *   - `currentOrganization`: The user's currently active organization or null
 *   - `organizations`: All organizations the user is a member of
 *   - `switchOrganization`: Function to switch to a different organization (triggers re-auth)
 *
 * @throws {Error} If used outside of AuthProvider
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { user, isLoading, hasPermission } = useAuth();
 *
 *   if (isLoading) return <Spinner />;
 *   if (!user) return <div>Not authenticated</div>;
 *
 *   return (
 *     <div>
 *       <h1>Welcome, {user.name}!</h1>
 *       {hasPermission('admin') && <AdminPanel />}
 *     </div>
 *   );
 * }
 * ```
 */
export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
