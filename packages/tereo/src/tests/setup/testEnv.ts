import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { parse } from "dotenv";
import path from "path";

/**
 * The test environment: `.env`, pointed at a separate database and Redis db
 * so tests never touch dev data, and at blob storage of that database's own
 * (`testStoragePath`). `globalSetup` migrates and seeds that
 * database, then starts one server on 4001 that every test file talks to.
 *
 * `TEST_DATABASE_URL` / `TEST_REDIS_URL`, from the shell or `.env`, override
 * the derived URLs, and `TEST_PORT` the server's port — so suites in two
 * worktrees can run side by side, or beside a core already on 4001. In Docker (DOCKER_TEST=true) the container environment is
 * used as-is.
 */
export function loadTestEnv(): Record<string, string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // A stand-in for the admin UI's build, so the suite covers the UI whether or
  // not the real one has been built.
  const UI_DIST_PATH = path.join(here, "../fixtures/ui-dist");
  // The partition tests wait out this timeout a dozen times. Kept above
  // Postgres's 1s deadlock_timeout, so their deadlock still is one.
  const PARTITION_DDL_LOCK_TIMEOUT_MS = "2000";
  if (process.env.DOCKER_TEST === "true") {
    return {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined)
      ) as Record<string, string>),
      UI_DIST_PATH,
      OIDC_ALLOW_PRIVATE_ISSUERS: "true",
      // The fake SMTP server speaks plaintext.
      ALLOW_PLAINTEXT_SMTP: "true",
      PARTITION_DDL_LOCK_TIMEOUT_MS,
    };
  }
  const envPath = path.resolve(here, "../../../.env");
  if (!existsSync(envPath)) {
    throw new Error(
      `.env not found at ${envPath} — copy .env.example and fill it in`
    );
  }
  const env = parse(readFileSync(envPath, "utf-8"));
  const db = new URL(env.DATABASE_URL);
  db.pathname = `${db.pathname}_test`;
  const redis = new URL(env.REDIS_URL);
  redis.pathname = "/1";
  const port = process.env.TEST_PORT ?? env.TEST_PORT ?? "4001";
  const databaseUrl =
    process.env.TEST_DATABASE_URL ?? env.TEST_DATABASE_URL ?? db.toString();
  const storage = testStoragePath(here, databaseUrl);
  return {
    ...env,
    PORT: port,
    PUBLIC_URL: `http://localhost:${port}`,
    DATABASE_URL: databaseUrl,
    FILE_SERVICE_STORAGE_PATH: storage,
    FILE_SERVICE_TEMP_PATH: path.join(storage, "temp"),
    REDIS_URL:
      process.env.TEST_REDIS_URL ?? env.TEST_REDIS_URL ?? redis.toString(),
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    UI_DIST_PATH,
    // The fake identity provider is on localhost.
    OIDC_ALLOW_PRIVATE_ISSUERS: "true",
    // The fake SMTP server speaks plaintext.
    ALLOW_PLAINTEXT_SMTP: "true",
    PARTITION_DDL_LOCK_TIMEOUT_MS,
  };
}

/**
 * Blob storage for one test database. A content blob's row holds the key its
 * file is encrypted under, and an upload of content that already has a row
 * shares it without writing a file. So the files must be the ones written for
 * that database's rows: one directory per database, never the dev server's
 * `./storage`, and the same one in every worktree that tests against it.
 */
function testStoragePath(here: string, databaseUrl: string): string {
  let root = path.resolve(here, "../../..");
  try {
    const common = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: here, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    root = path.join(path.dirname(common), "packages/tereo");
  } catch {
    // Not a git checkout: this package's own directory.
  }
  const url = new URL(databaseUrl);
  const name = `${url.hostname}-${url.port || "5432"}-${url.pathname.slice(1)}`;
  return path.join(root, "storage/test", name.replace(/[^\w.-]/g, "_"));
}
