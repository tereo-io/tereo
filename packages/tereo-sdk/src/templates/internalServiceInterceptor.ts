import type { RequestInterceptor } from "@dianemo/core/client/types";
import { getRequestId } from "../utils/requestId.js";

/**
 * Forwards the inbound request's `X-Request-ID` (from `requestIdMiddleware`)
 * on calls to core, through the core client and its `:public` twin. Outside a
 * request (scripts, jobs) there is no id and the call goes without one.
 */
export const internalServiceRequestInterceptor: RequestInterceptor = (
  config
) => {
  const requestId = getRequestId();
  if (!requestId) return config;
  return {
    ...config,
    headers: { ...(config.headers ?? {}), "X-Request-ID": requestId },
  };
};
