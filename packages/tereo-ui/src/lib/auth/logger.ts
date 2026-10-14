import env from "./config";

/**
 * Internal debug logger that only logs when debug mode is enabled.
 * @internal
 */
export const debugLog = (...args: unknown[]): void => {
  if (env.debug) console.log("[auth]", ...args);
};

/**
 * Internal error logger that always logs errors.
 * @internal
 */
export const errorLog = (...args: unknown[]): void => {
  console.error("[auth]", ...args);
};
