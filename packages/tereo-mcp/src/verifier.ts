import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/express";
import { authContextFromIntrospection } from "@tereo-io/sdk";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { AuthContext, CoreClient } from "@tereo-io/sdk";
import type { Logger } from "pino";

type RefusalReason =
  "inactive" | "client_not_allowed" | "service_account" | "expired";

export const createVerifier = (opts: {
  core: CoreClient;
  allowedClients: string[];
  allowServiceAccounts: boolean;
  resourceUrl: string;
  now?: () => number;
  logger?: Logger;
}): OAuthTokenVerifier => {
  const now = opts.now ?? Date.now;

  // The SDK sends this message to the client, so it is the same for every
  // reason; the real one goes to the log only.
  const refuse = (reason: RefusalReason, clientId?: string): never => {
    opts.logger?.info({ reason, client_id: clientId }, "MCP token refused");
    throw new OAuthError(
      OAuthErrorCode.InvalidToken,
      "Invalid or expired token"
    );
  };

  return {
    async verifyAccessToken(token) {
      const res = await opts.core.auth.introspectToken(token);
      if (!res.active) return refuse("inactive");
      if (!opts.allowedClients.includes(res.client_id)) {
        return refuse("client_not_allowed", res.client_id);
      }
      const auth = authContextFromIntrospection(res);
      if (auth.userType === "service_account" && !opts.allowServiceAccounts) {
        return refuse("service_account", res.client_id);
      }
      if (res.exp * 1000 <= now()) return refuse("expired", res.client_id);

      return {
        token,
        clientId: res.client_id,
        scopes: auth.scope,
        expiresAt: res.exp,
        resource: new URL(opts.resourceUrl),
        extra: { auth },
      };
    },
  };
};

export const authFromInfo = (
  info: AuthInfo | undefined
): AuthContext | undefined => info?.extra?.auth as AuthContext | undefined;
