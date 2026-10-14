export interface AuthConfigOptions {
  AUTH_SERVER_URL: string;
  REDIRECT_URI: string;
  CLIENT_ID: string;
  /**
   * Path the app is served under, without a trailing slash ("" at the root).
   * Stripped from the location before matching public routes.
   * @default ""
   */
  basePath?: string;
  /**
   * Path to redirect to after logout or unauthorized access.
   * WARNING: This MUST be a publicly accessible route (not protected by auth)
   * to avoid infinite redirect loops.
   * @default "/"
   */
  logoutRedirectPath?: string;
  /**
   * Path to redirect to for unauthorized users (when no token exists).
   * WARNING: This MUST be a publicly accessible route (not protected by auth)
   * to avoid infinite redirect loops.
   * @default "/"
   */
  unauthorizedRedirectPath?: string;
  /**
   * Buffer time in milliseconds before token expiration to trigger refresh.
   * Lower values reduce unnecessary refreshes but increase risk of using expired tokens.
   * @default 30000 (30 seconds)
   */
  tokenExpirationBuffer?: number;
  /**
   * WebSocket path for real-time updates.
   * @default "/ws"
   */
  wsPath?: string;
  /**
   * Enable debug logging for troubleshooting auth issues.
   * @default false
   */
  debug?: boolean;
}

export interface AuthConfig {
  AUTH_SERVER_URL: string;
  REDIRECT_URI: string;
  CLIENT_ID: string;
  basePath: string;
  TOKEN_KEY: string;
  PKCE_KEY: string;
  LOGGED_OUT_KEY: string;
  logoutRedirectPath: string;
  unauthorizedRedirectPath: string;
  tokenExpirationBuffer: number;
  wsPath: string;
  debug: boolean;
}

let config: AuthConfig | null = null;

/**
 * Configure the UI's auth client.
 * Call it once, before anything that signs in or calls core.
 */
export const configureAuth = (userConfig: AuthConfigOptions): void => {
  config = {
    ...userConfig,
    TOKEN_KEY: "tereo_tokens",
    PKCE_KEY: "tereo_pkce",
    LOGGED_OUT_KEY: "tereo_logged_out",
    basePath: userConfig.basePath ?? "",
    logoutRedirectPath: userConfig.logoutRedirectPath ?? "/",
    unauthorizedRedirectPath: userConfig.unauthorizedRedirectPath ?? "/",
    tokenExpirationBuffer: userConfig.tokenExpirationBuffer ?? 30000,
    wsPath: userConfig.wsPath ?? "/ws",
    debug: userConfig.debug ?? false,
  };
};

/**
 * Get the current SDK configuration.
 * Throws an error if the SDK hasn't been configured yet.
 */
const getConfig = (): Required<AuthConfig> => {
  if (!config) {
    throw new Error(
      "Auth not configured. Call configureAuth() before signing in or calling core."
    );
  }
  return config as Required<AuthConfig>;
};

const env = {
  get AUTH_SERVER_URL() {
    return getConfig().AUTH_SERVER_URL;
  },
  get REDIRECT_URI() {
    return getConfig().REDIRECT_URI;
  },
  get CLIENT_ID() {
    return getConfig().CLIENT_ID;
  },
  get basePath() {
    return getConfig().basePath;
  },
  get TOKEN_KEY() {
    return getConfig().TOKEN_KEY;
  },
  get PKCE_KEY() {
    return getConfig().PKCE_KEY;
  },
  get LOGGED_OUT_KEY() {
    return getConfig().LOGGED_OUT_KEY;
  },
  get logoutRedirectPath() {
    return getConfig().logoutRedirectPath;
  },
  get unauthorizedRedirectPath() {
    return getConfig().unauthorizedRedirectPath;
  },
  get tokenExpirationBuffer() {
    return getConfig().tokenExpirationBuffer;
  },
  get wsPath() {
    return getConfig().wsPath;
  },
  get debug() {
    return getConfig().debug;
  },
};

export default env;
