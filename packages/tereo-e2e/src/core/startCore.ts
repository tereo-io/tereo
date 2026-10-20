import { createWriteStream, existsSync, mkdirSync, rmSync } from "fs";
import { execFileSync, spawn } from "child_process";
import { coreEnv } from "./coreEnv.js";
import { e2e } from "../config.js";
import { Redis } from "ioredis";
import path from "path";
import pg from "pg";

/**
 * Playwright's webServer command. Starts every run from nothing: drops and
 * recreates the e2e database, clears the e2e Redis keys and blob storage,
 * builds the admin UI, migrates and seeds, then runs core in the foreground
 * until Playwright stops it.
 *
 * E2E_SKIP_UI_BUILD=1 reuses the last build, for quick reruns of a spec.
 */

// stderr: Playwright shows it, and drops the build and migration chatter on
// stdout (playwright.config.ts).
const log = (message: string) => console.error(`[e2e] ${message}`);

async function recreateDatabase() {
  const admin = new URL(e2e.databaseUrl);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const name = client.escapeIdentifier(e2e.databaseName);
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
}

// Only this run's prefix in its own db: rate-limit counters, BullMQ queues
// and caches left by the last run would point at rows that no longer exist.
async function clearRedis() {
  const redis = new Redis(e2e.redisUrl, {
    db: e2e.redisDb,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis.connect();
  try {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(
        cursor,
        "MATCH",
        `${e2e.redisKeyPrefix}*`,
        "COUNT",
        1000
      );
      cursor = next;
      if (keys.length) await redis.unlink(...keys);
    } while (cursor !== "0");
  } finally {
    redis.disconnect();
  }
}

const run = (cmd: string, args: string[], cwd: string, env = coreEnv()) =>
  execFileSync(cmd, args, { cwd, env, stdio: "inherit" });

function buildUi() {
  if (process.env.E2E_SKIP_UI_BUILD === "1" && existsSync(e2e.uiDistPath)) {
    log("Reusing the last UI build (E2E_SKIP_UI_BUILD=1)");
    return;
  }
  log("Building the admin UI");
  // Vite never lets a .env file override a variable already set, so a
  // developer's VITE_CORE_URL cannot point this build at their dev core.
  run(
    "npm",
    ["run", "build", "--", "--outDir", e2e.uiDistPath, "--emptyOutDir"],
    e2e.uiPackage,
    {
      ...process.env,
      VITE_CORE_URL: "",
      VITE_CLIENT_ID: "",
      VITE_REDIRECT_URI: "",
    }
  );
}

async function main() {
  mkdirSync(e2e.stateDir, { recursive: true });
  buildUi();

  log(`Recreating database ${e2e.databaseName}`);
  await recreateDatabase();
  log(`Clearing Redis db ${e2e.redisDb}, prefix ${e2e.redisKeyPrefix}`);
  await clearRedis();
  rmSync(e2e.storagePath, { recursive: true, force: true });
  rmSync(e2e.adminStatePath, { force: true });

  if (!existsSync(path.join(e2e.corePackage, "prisma/generated/client"))) {
    run("npx", ["prisma", "generate"], e2e.corePackage);
  }
  log("Migrating and seeding");
  run("npx", ["prisma", "migrate", "deploy"], e2e.corePackage);
  run("npx", ["tsx", "src/scripts/seed.ts"], e2e.corePackage);

  log(`Starting core on ${e2e.baseURL} (log: ${e2e.coreLogPath})`);
  const logFile = createWriteStream(e2e.coreLogPath);
  // One process, with tsx as a loader rather than a wrapper around a child,
  // so the SIGTERM forwarded below reaches core itself. The entry point
  // starts the server only when it is argv[1], which an absolute path is.
  const core = spawn(
    process.execPath,
    ["--import", "tsx", path.join(e2e.corePackage, "src/index.ts")],
    {
      cwd: e2e.corePackage,
      env: coreEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  core.stdout.pipe(logFile);
  core.stderr.pipe(logFile);
  core.stderr.pipe(process.stderr);

  const stop = () => core.kill("SIGTERM");
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  core.on("exit", (code, signal) => {
    if (code) log(`core exited with ${code}; see ${e2e.coreLogPath}`);
    process.exit(code ?? (signal ? 0 : 1));
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
