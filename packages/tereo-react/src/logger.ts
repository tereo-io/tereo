import { activeConfig } from "./config.js";

export const debugLog = (...args: unknown[]): void => {
  if (activeConfig().debug) console.log("[tereo]", ...args);
};

export const errorLog = (...args: unknown[]): void => {
  console.error("[tereo]", ...args);
};
