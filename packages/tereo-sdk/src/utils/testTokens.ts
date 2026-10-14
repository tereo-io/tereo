import type { ActiveIntrospectionResponse } from "../types/auth.js";
import crypto from "crypto";

/**
 * Parse a test token into an ActiveIntrospectionResponse.
 *
 * Supported formats:
 * - `test-token-{userId}` — basic
 * - `test-token-{userId}|org={orgId}` — with organization
 * - `test-token-{userId}|org={orgId}|org_name={name}` — with org name
 * - `test-token-{userId}|perms={perm1},{perm2}` — custom permissions
 * - `test-token-{userId}|org={orgId}|org_name={name}|perms={perm1},{perm2}` — all
 *
 * Returns `null` if the token doesn't match the test token format.
 */
export function parseTestToken(
  token: string,
  defaultPermissions: string[]
): ActiveIntrospectionResponse | null {
  if (!token.startsWith("test-token-")) return null;

  const rawPayload = token.replace("test-token-", "");
  const parts = rawPayload.split("|");
  const userId = parts[0];

  if (!userId) return null;

  let permissions = defaultPermissions;
  let orgId: string | undefined;
  let orgName: string | undefined;

  for (let i = 1; i < parts.length; i++) {
    const [key, value] = parts[i].split("=");
    if (key === "org") orgId = value;
    if (key === "org_name") orgName = value;
    if (key === "perms") permissions = value.split(",");
  }

  return {
    active: true,
    sub: userId,
    user_id: userId,
    jti: crypto.randomUUID(),
    iss: "tereo",
    scope: "openid profile email",
    permissions,
    client_id: "test-client",
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    org_id: orgId,
    org_name: orgName,
  };
}
