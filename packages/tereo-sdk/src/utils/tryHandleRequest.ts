import type { RequestConfig } from "@dianemo/core/request/types";
import { RequestError, RequestErrorMetadata } from "./errors.js";
import { isAxiosError, type AxiosResponse } from "axios";
import { logger } from "./logger.js";
import {
  CORE_PUBLIC_CLIENT,
  getHandler,
  purgeServiceToken,
} from "../handler.js";

interface TryHandleRequestOptions {
  context?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Executes an HTTP request via requestHandler with built-in error handling.
 * Pass the RequestConfig directly - no need to wrap in a function.
 *
 * @example
 * const res = await tryHandleRequest<UserData>(
 *   { clientName: "ups", method: "GET", url },
 *   "UPS_0001",
 *   "An error occurred while fetching UPS data"
 * );
 */
export async function tryHandleRequest<T = unknown>(
  config: RequestConfig,
  code: string,
  message: string,
  options?: TryHandleRequestOptions
): Promise<AxiosResponse<T>> {
  try {
    return (await send(config)) as AxiosResponse<T>;
  } catch (error) {
    if (error instanceof RequestError) throw error;

    const metadata: RequestErrorMetadata = {
      ...options?.metadata,
      client: config.clientName,
      context:
        options?.context ??
        (error instanceof Error ? error.message : undefined),
      originalError: formatError(error),
    };

    throw new RequestError(code, message, {
      metadata,
      cause: error instanceof Error ? error : undefined,
    });
  }
}

/**
 * Sends `config`, and once more with a fresh token when core answers 401 to
 * the cached one — revoked, or signed with a key core has since rotated. The
 * cached token would otherwise be sent until it expired.
 */
async function send(config: RequestConfig): Promise<AxiosResponse> {
  try {
    return await getHandler().handleRequest(config);
  } catch (error) {
    if (!isRejectedToken(config, error)) throw error;
    try {
      await purgeServiceToken();
    } catch (purgeError) {
      logger.error(
        { err: purgeError },
        "Could not drop the service token core rejected"
      );
      throw error;
    }
    logger.warn(
      { requestName: config.requestName },
      "Core rejected the service token; retrying once with a new one"
    );
    return await getHandler().handleRequest(config);
  }
}

function isRejectedToken(config: RequestConfig, error: unknown): boolean {
  return (
    // The `:public` client authenticates with Basic credentials, not a token.
    config.clientName !== CORE_PUBLIC_CLIENT &&
    isAxiosError(error) &&
    error.response?.status === 401 &&
    // A stream body was consumed by the first attempt.
    !isStream(config.data)
  );
}

const isStream = (data: unknown): boolean =>
  typeof (data as { pipe?: unknown } | null)?.pipe === "function";

function formatError(error: unknown): Record<string, unknown> {
  // isAxiosError checks a flag, not the class: @dianemo/core may throw errors
  // from its own copy of axios, which `instanceof` against ours would miss —
  // dropping the status every caller branches on.
  if (isAxiosError(error)) {
    return {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
    };
  }
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { error };
}
