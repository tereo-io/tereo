import type { AxiosInstance } from "axios";

export interface TereoUser {
  permissions: string[];
  [key: string]: unknown;
}

export type TereoEvent =
  | { type: "permissions"; payload: { reason: string; timestamp: number } }
  | {
      type: "organization";
      payload: { reason: string; organizationId?: string; timestamp: number };
    }
  | {
      type: "session-revoked";
      payload: { sessionId: string; timestamp: number };
    };

export interface TereoAuthConfig {
  coreUrl: string;
  clientId: string;
  redirectUri: string;
  /** Name → base URL of each API the app calls with the user's token. */
  apis: Record<string, string>;
  loadUser: (apis: Record<string, AxiosInstance>) => Promise<TereoUser>;
  /** @default "openid profile email offline_access" */
  scopes?: string;
  /** Path the app is served under, without a trailing slash. @default "" */
  basePath?: string;
  /** Routes that need no session. @default the redirect path and `signedOutPath` */
  isPublicPath?: (routePath: string) => boolean;
  /** Where a signed-out visitor lands. Must be public. @default "/" */
  signedOutPath?: string;
  /** @default `tereo_${clientId}` */
  storagePrefix?: string;
  /** Milliseconds before expiry at which a token is renewed. @default 30000 */
  tokenExpirationBuffer?: number;
  /** @default 15000 */
  requestTimeoutMs?: number;
  /** Open core's socket for live updates. @default true */
  live?: boolean;
  /** @default "/ws" */
  wsPath?: string;
  onEvent?: (event: TereoEvent) => void;
  /** @default false */
  debug?: boolean;
}

export interface StorageKeys {
  tokens: string;
  pkce: string;
  loggedOut: string;
  signedIn: string;
  postLoginPath: string;
}

export type ResolvedConfig = Required<Omit<TereoAuthConfig, "onEvent">> &
  Pick<TereoAuthConfig, "onEvent"> & { keys: StorageKeys };

const pathWithoutBase = (pathname: string, basePath: string): string =>
  basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`))
    ? pathname.slice(basePath.length) || "/"
    : pathname;

export const resolveConfig = (c: TereoAuthConfig): ResolvedConfig => {
  const basePath = c.basePath ?? "";
  const signedOutPath = c.signedOutPath ?? "/";
  const storagePrefix = c.storagePrefix ?? `tereo_${c.clientId}`;
  const redirectPath = pathWithoutBase(
    new URL(c.redirectUri, "http://localhost").pathname,
    basePath
  );

  return {
    ...c,
    scopes: c.scopes ?? "openid profile email offline_access",
    basePath,
    signedOutPath,
    isPublicPath:
      c.isPublicPath ??
      ((routePath) =>
        routePath === redirectPath || routePath === signedOutPath),
    storagePrefix,
    tokenExpirationBuffer: c.tokenExpirationBuffer ?? 30_000,
    requestTimeoutMs: c.requestTimeoutMs ?? 15_000,
    live: c.live ?? true,
    wsPath: c.wsPath ?? "/ws",
    debug: c.debug ?? false,
    keys: {
      tokens: `${storagePrefix}_tokens`,
      pkce: `${storagePrefix}_pkce`,
      loggedOut: `${storagePrefix}_logged_out`,
      signedIn: `${storagePrefix}_signed_in`,
      postLoginPath: `${storagePrefix}_post_login_path`,
    },
  };
};

let active: ResolvedConfig | null = null;

export const setActiveConfig = (c: ResolvedConfig | null): void => {
  active = c;
};

export const activeConfig = (): ResolvedConfig => {
  if (!active) throw new Error("TereoAuthProvider is not mounted");
  return active;
};
