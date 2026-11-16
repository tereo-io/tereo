import { type PermissionRequirement, hasPermission } from "./permissions.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type StoredTokens } from "./tokens.js";
import { useStoredValue } from "./storage.js";
import { refreshTokens } from "./refresh.js";
import { createApiClients } from "./api.js";
import type { AxiosInstance } from "axios";
import { hasSession } from "./markers.js";
import { signOut } from "./signOut.js";
import { signIn } from "./signIn.js";
import {
  type ResolvedConfig,
  type TereoAuthConfig,
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
  const queryKey = userKey(clientId);

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

  // Live updates (core's socket) attach here and drive `isLive`.
  const isLive = false;

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
