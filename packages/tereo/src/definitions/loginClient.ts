import { coreScopesOf } from "./coreScopes.js";

// The admin UI's public OAuth client. Its client_id is fixed so the UI can be
// built without knowing anything about the deployment; tereo-ui
// carries the same literal. Databases seeded before it was fixed have a
// random id under the same name, which the seed rewrites.
export const LOGIN_CLIENT = {
  clientId: "tereo-ui",
  name: "Default Login Client",
} as const;

/**
 * What the UI needs of its client, derived from where it is served. Core sets
 * these on every start and admins cannot edit them: a change of UI_BASE_URL
 * moves the redirect URI, and the UI refreshes its session with the
 * `refresh_token` grant.
 */
export const loginClientConfig = (uiBaseUrl: string) => ({
  clientType: "public" as const,
  redirectUris: [`${uiBaseUrl}/callback`],
  grantTypes: ["authorization_code", "refresh_token"],
  scopes: ["openid", "profile", "email", "offline_access"],
});

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const isLoopbackUri = (uri: string): boolean => {
  try {
    return LOOPBACK_HOSTS.has(new URL(uri).hostname);
  } catch {
    return false;
  }
};

/**
 * The login client's redirect URIs at a start, given the ones it has. In
 * production exactly `${UI_BASE_URL}/callback`. Elsewhere that callback
 * first, then the loopback callbacks already registered, so cores serving
 * the UI from different local addresses (compose on :4001, `npm run dev`
 * on :4000) can share one database without logging each other's UI out. A
 * non-loopback URI is not kept even in development: the client skips the
 * consent screen, so a stale callback on a host nobody controls would hand
 * it codes.
 */
export const loginClientRedirectUris = (
  existing: readonly string[],
  uiBaseUrl: string,
  production: boolean
): string[] => {
  const callback = `${uiBaseUrl}/callback`;
  if (production) return [callback];
  return [...new Set([callback, ...existing.filter(isLoopbackUri)])];
};

/**
 * Clients that are part of core itself. Their tokens act in core's API with
 * the user's full rights, whatever their scopes. Identified by their fixed
 * client_id.
 */
export const isFirstPartyClient = (clientId: string): boolean =>
  clientId === LOGIN_CLIENT.clientId;

/**
 * Whether the user is spared the consent screen for this request: always for
 * core's own client, which has no screen to show; for any other, never when
 * the request says `prompt=consent`; for one marked `consentRequired: false`,
 * only when every core API scope it asks for is one its provisioning trusts,
 * since those act in core as the user. Only the screen is skipped; what the
 * client's tokens may do in core's API is decided by `isFirstPartyClient`
 * and the scopes.
 */
export const skipsConsent = (
  client: {
    clientId: string;
    consentRequired: boolean;
    trustedCoreScopes: string[];
  },
  scopes: string[],
  prompt: string | null | undefined = null
): boolean =>
  isFirstPartyClient(client.clientId) ||
  (!client.consentRequired &&
    !(prompt ?? "").split(" ").includes("consent") &&
    coreScopesOf(scopes).every((s) =>
      client.trustedCoreScopes.includes(s.name)
    ));
