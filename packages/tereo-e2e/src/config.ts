import { fileURLToPath } from "url";
import path from "path";

/**
 * The e2e environment, shared by the Playwright config, the script that
 * starts core and the specs. Everything defaults away from the dev stack
 * (core on 4001, database `core`, Redis db 0) and the backend suite's
 * (`core_test`, Redis db 1), so a run never touches either.
 */

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const repoRoot = path.resolve(packageRoot, "../..");

const port = Number(process.env.E2E_PORT ?? 4501);

const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  "postgresql://core:core@localhost:5442/core_e2e";

// Dropped and recreated on every run, so it must be unmistakably the e2e one.
const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!/_e2e$/.test(databaseName)) {
  throw new Error(
    `E2E_DATABASE_URL names "${databaseName}"; the e2e database is dropped on every run, so its name must end in _e2e`
  );
}

// With its own E2E_STATE_DIR, port, database and Redis prefix, a run keeps
// its UI build, admin session and log apart, so two runs can overlap.
const stateDir = path.resolve(
  packageRoot,
  process.env.E2E_STATE_DIR ?? ".e2e-state"
);

export const e2e = {
  packageRoot,
  repoRoot,
  corePackage: path.join(repoRoot, "packages/tereo"),
  uiPackage: path.join(repoRoot, "packages/tereo-ui"),

  port,
  baseURL: `http://localhost:${port}`,

  databaseUrl,
  databaseName,
  redisUrl: process.env.E2E_REDIS_URL ?? "redis://localhost:6389",
  redisDb: Number(process.env.E2E_REDIS_DB ?? 3),
  redisKeyPrefix: process.env.E2E_REDIS_KEY_PREFIX ?? "tereo-e2e:",

  // Core accepts SETUP_TOKEN (24+ characters) in place of the one it logs.
  setupToken: "E2E0-SETUP-TOKEN-0000-0000-0000",

  stateDir,
  uiDistPath: path.join(stateDir, "ui-dist"),
  storagePath: path.join(stateDir, "storage"),
  coreLogPath: path.join(stateDir, "core.log"),
  adminStatePath: path.join(stateDir, "admin.json"),

  /** The admin first-run setup creates, which every other spec signs in as. */
  admin: {
    name: "E2E Admin",
    email: "admin@e2e.test",
    password: "E2e-Admin-Passw0rd!",
  },
  organization: { name: "E2E Org", slug: "e2e-org", code: "E2EORG" },
} as const;
