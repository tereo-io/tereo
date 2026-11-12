import type { ActiveIntrospectionResponse } from "../requests/auth/oauth/types.js";
import type { AuthContext } from "../types/auth.js";

/**
 * Core sets a token's `sub` to the user it was issued for, or to the client's
 * own id for a client_credentials token. A session id is no guide: a person's
 * token minted without a refresh token has none.
 */
const tokenUserType = (
  res: Pick<ActiveIntrospectionResponse, "sub" | "client_id">
): AuthContext["userType"] =>
  res.sub && res.sub !== res.client_id ? "human" : "service_account";

export const authContextFromIntrospection = (
  res: ActiveIntrospectionResponse
): AuthContext => ({
  userId: res.user_id,
  email: res.email || null,
  name: res.name || null,
  userType: tokenUserType(res),
  permissions: res.permissions || [],
  currentSessionId: res.sid || null,
  clientId: res.client_id,
  scope: res.scope ? res.scope.split(" ").filter(Boolean) : [],
  audience: res.aud === undefined ? [] : [res.aud].flat(),
  oauthClientId: res.client_id || null,
  organizationId: res.org_id || null,
  organizationName: res.org_name || null,
});
