import { tryHandleRequest } from "../../../utils/tryHandleRequest.js";
import { CORE_PUBLIC_CLIENT } from "../../../handler.js";
import type {
  IntrospectionResponse,
  ServiceAccessTokenResponse,
} from "./types.js";

export * from "./types.js";

// The `:public` client sends this service's client credentials as Basic auth.
export const introspectToken = async (
  token: string
): Promise<IntrospectionResponse> => {
  const res = await tryHandleRequest<IntrospectionResponse>(
    {
      clientName: CORE_PUBLIC_CLIENT,
      requestName: "core.auth.introspectToken",
      method: "POST",
      url: "/oauth/introspect",
      data: { token },
      headers: { "Content-Type": "application/json" },
    },
    "AS_0010",
    "Failed to introspect token"
  );
  return res.data;
};

/**
 * The core client already fetches and refreshes its own token; call this only
 * to hand a service-account token to something else verbatim.
 */
export const getServiceAccessToken = async (
  scopes?: string[]
): Promise<ServiceAccessTokenResponse> => {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: scopes ? scopes.join(" ") : "openid",
  });
  const res = await tryHandleRequest<ServiceAccessTokenResponse>(
    {
      clientName: CORE_PUBLIC_CLIENT,
      requestName: "core.auth.getServiceAccessToken",
      method: "POST",
      url: "/oauth/token",
      data: body.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    },
    "AS_0011",
    "Failed to obtain service access token"
  );
  return res.data;
};
