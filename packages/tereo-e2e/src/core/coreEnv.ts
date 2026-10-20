import { e2e } from "../config.js";
import path from "path";

/**
 * Core's environment for an e2e run: complete on its own, so a developer's
 * packages/tereo/.env (which `dotenv/config` would load from core's working
 * directory) can neither point the run at their dev database nor change its
 * behaviour.
 */
export const coreEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  // dotenv/config reads this instead of ./.env; the file never exists.
  DOTENV_CONFIG_PATH: path.join(e2e.stateDir, "no.env"),
  DOTENV_CONFIG_QUIET: "true",

  NODE_ENV: "development",
  LOG_LEVEL: process.env.E2E_CORE_LOG_LEVEL ?? "info",
  ROLE: "all",
  PORT: String(e2e.port),
  PUBLIC_URL: e2e.baseURL,
  // Core serves the UI build itself; the seed registers this origin's
  // /callback on the UI's login client.
  UI_BASE_URL: e2e.baseURL,
  UI_DIST_PATH: e2e.uiDistPath,

  DATABASE_URL: e2e.databaseUrl,
  REDIS_URL: e2e.redisUrl,
  REDIS_DB: String(e2e.redisDb),
  REDIS_KEY_PREFIX: e2e.redisKeyPrefix,

  FILE_SERVICE_STORAGE_PATH: e2e.storagePath,
  FILE_SERVICE_TEMP_PATH: path.join(e2e.storagePath, "temp"),

  SETUP_TOKEN: e2e.setupToken,
});
