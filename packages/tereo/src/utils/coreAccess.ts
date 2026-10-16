import { hasPermission } from "./permissions.js";
import {
  CORE_AUDIENCE,
  CORE_SCOPES,
  coreScopesOf,
  isFirstPartyClient,
  type CoreArea,
  type CoreScope,
} from "../definitions/index.js";

/**
 * What an access token may do in core's own API (/account, /admin, /files,
 * /audit, /webhooks):
 *
 * - `full` — issued to core's UI or to a service: the user's (or service
 *   account's) live permissions, everywhere.
 * - `delegated` — issued to any other client with core API scopes, and so
 *   with core in its audience: only the areas those scopes name, and the live
 *   permissions cut down to their ceilings.
 * - `none` — any other token. It is for its own client or an app service,
 *   not for core.
 */
export type CoreAccess =
  | { kind: "full" }
  | { kind: "delegated"; scopes: CoreScope[] }
  | { kind: "none" };

export const resolveCoreAccess = (token: {
  clientId: string;
  /** The client belongs to a service, or the token is client_credentials. */
  isServiceClient: boolean;
  scopes: string[];
}): CoreAccess => {
  if (isFirstPartyClient(token.clientId) || token.isServiceClient) {
    return { kind: "full" };
  }
  const scopes = coreScopesOf(token.scopes);
  return scopes.length > 0 ? { kind: "delegated", scopes } : { kind: "none" };
};

/** Whether the token may reach the router for `area` (any of them) at all. */
export const allowsArea = (
  access: CoreAccess,
  area: CoreArea | CoreArea[]
): boolean => {
  const areas = [area].flat();
  return (
    access.kind === "full" ||
    (access.kind === "delegated" &&
      access.scopes.some((s) => areas.includes(s.area)))
  );
};

/**
 * The permissions that hold for the token: `live` itself for full access,
 * otherwise each live permission met with each ceiling — the narrower of the
 * two where one covers the other. Coverage is hierarchical (`admin` ⊇
 * `x.admin` ⊇ `x.delete` ⊇ … ⊇ `x.read`), and the permissions covering any one
 * name form a chain, so `hasPermission(result, p)` holds exactly when both
 * `live` and a ceiling cover `p`.
 */
export const effectivePermissions = (
  live: string[],
  access: CoreAccess
): string[] => {
  if (access.kind === "full") return live;
  if (access.kind === "none") return [];
  return capToCeiling(
    live,
    access.scopes.flatMap((s) => s.ceiling)
  );
};

/**
 * `live` cut down to `ceiling` as `effectivePermissions` does, or `live`
 * itself without one (`AuthContext.ceiling` is absent for full access).
 */
export const capToCeiling = (
  live: string[],
  ceiling: string[] | undefined
): string[] => {
  if (!ceiling) return live;
  const result = new Set<string>();
  for (const granted of live) {
    for (const cap of ceiling) {
      if (hasPermission([cap], granted)) result.add(granted);
      else if (hasPermission([granted], cap)) result.add(cap);
    }
  }
  return [...result];
};

/**
 * The audience of a token core issues: the client's approved audiences, and
 * core's own when the grant includes a core API scope.
 */
export const tokenAudience = (
  clientAudience: string[],
  scopes: string[]
): string[] =>
  coreScopesOf(scopes).length > 0 && !clientAudience.includes(CORE_AUDIENCE)
    ? [...clientAudience, CORE_AUDIENCE]
    : clientAudience;

/** The scopes that would admit a token to `area` (any of them), for a challenge. */
export const scopesForArea = (area: CoreArea | CoreArea[]): string[] => {
  const areas = [area].flat();
  return CORE_SCOPES.filter((s) => areas.includes(s.area)).map((s) => s.name);
};
