import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { parse } from "dotenv";
import path from "path";

/**
 * The test environment: `.env`, pointed at a separate database and Redis db
 * so tests never touch dev data. `globalSetup` migrates and seeds that
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
  const UI_DIST_PATH = path.join(here, "fixtures/ui-dist");
  if (process.env.DOCKER_TEST === "true") {
    return {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined)
      ) as Record<string, string>),
      UI_DIST_PATH,
      OIDC_ALLOW_PRIVATE_ISSUERS: "true",
      // The fake SMTP server speaks plaintext.
      ALLOW_PLAINTEXT_SMTP: "true",
    };
  }
  const envPath = path.resolve(here, "../../.env");
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
  return {
    ...env,
    PORT: port,
    PUBLIC_URL: `http://localhost:${port}`,
    DATABASE_URL:
      process.env.TEST_DATABASE_URL ?? env.TEST_DATABASE_URL ?? db.toString(),
    REDIS_URL:
      process.env.TEST_REDIS_URL ?? env.TEST_REDIS_URL ?? redis.toString(),
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    UI_DIST_PATH,
    // The fake identity provider is on localhost.
    OIDC_ALLOW_PRIVATE_ISSUERS: "true",
    // The fake SMTP server speaks plaintext.
    ALLOW_PLAINTEXT_SMTP: "true",
  };
}
