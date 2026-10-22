import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, execFileSync } from "child_process";
import { createHash, randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { Pool } from "pg";
import path from "path";

/**
 * Presign and cursor signing keys supplied in env, at any version, loaded by
 * a child process against a database of its own.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "../../..");
const childScript = path.join(here, "../fixtures/printEnvKeysChild.ts");
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");

// No `.env` in the child's working directory, so dotenv adds nothing back.
const workDir = mkdtempSync(path.join(tmpdir(), "core-env-signing-keys-"));

const suiteDbUrl = new URL(process.env.DATABASE_URL!);
const isolatedDbName = `${suiteDbUrl.pathname.slice(1)}_env_signing_keys`;
const isolatedDbUrl = new URL(suiteDbUrl);
isolatedDbUrl.pathname = `/${isolatedDbName}`;

const keyEnvPattern =
  /^(JWT_(PRIVATE_KEY|PUBLIC_KEY|KEY_ID)|TOTP_ENCRYPTION_KEY|\w+_SIGNING_KEY_V\d+|\w+_ACTIVE_SIGNING_KEY_VERSION|FILE_SERVICE_MASTER_KEY_V\d+|CORE_KEK(_PREVIOUS)?|AUTH_CODE_HMAC_KEY|KNOWN_DEVICE_KEY)$/;

const baseEnv = {
  ...(Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => value !== undefined && !keyEnvPattern.test(name)
    )
  ) as Record<string, string>),
  DATABASE_URL: isolatedDbUrl.toString(),
};

const runChild = (extraEnv: Record<string, string>) =>
  new Promise<Record<string, string | null>>((resolve, reject) => {
    execFile(
      process.execPath,
      [tsxCli, childScript],
      {
        cwd: workDir,
        env: { ...baseEnv, ...extraEnv, NODE_OPTIONS: "", LOG_LEVEL: "silent" },
        timeout: 60_000,
      },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${err.message}\n${stderr}`));
        resolve(JSON.parse(stdout));
      }
    );
  });

const fingerprint = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

let db: Pool;

const storedNames = async () =>
  (
    await db.query<{ name: string }>(
      `SELECT name FROM "core"."secrets" WHERE name LIKE '%\\_SIGNING\\_KEY\\_V%' AND name NOT LIKE 'JWT\\_%'`
    )
  ).rows.map((row) => row.name);

describe("Signing keys supplied in env", () => {
  beforeAll(async () => {
    const admin = new Pool({ connectionString: suiteDbUrl.toString() });
    try {
      await admin.query(
        `DROP DATABASE IF EXISTS "${isolatedDbName}" WITH (FORCE)`
      );
      await admin.query(`CREATE DATABASE "${isolatedDbName}"`);
    } finally {
      await admin.end();
    }
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      cwd: packageRoot,
      env: { ...process.env, DATABASE_URL: isolatedDbUrl.toString() },
      stdio: ["ignore", "ignore", "inherit"],
    });
    db = new Pool({ connectionString: isolatedDbUrl.toString() });
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    const admin = new Pool({ connectionString: suiteDbUrl.toString() });
    await admin
      .query(`DROP DATABASE IF EXISTS "${isolatedDbName}" WITH (FORCE)`)
      .finally(() => admin.end());
    rmSync(workDir, { recursive: true, force: true });
  });

  it("signs with an env key past V2 as the active version, and never stores it", async () => {
    const files = randomBytes(32).toString("base64");
    const cursor = randomBytes(32).toString("base64");
    const printed = await runChild({
      FILE_SERVICE_ACTIVE_SIGNING_KEY_VERSION: "3",
      FILE_SERVICE_SIGNING_KEY_V3: files,
      CURSOR_ACTIVE_SIGNING_KEY_VERSION: "4",
      CURSOR_SIGNING_KEY_V4: cursor,
      PRINT_KEYS: "FILE_SERVICE_SIGNING_KEY_V3,CURSOR_SIGNING_KEY_V4",
    });
    expect(printed).toEqual({
      FILE_SERVICE_SIGNING_KEY_V3: fingerprint(files),
      CURSOR_SIGNING_KEY_V4: fingerprint(cursor),
    });
    expect(await storedNames()).toEqual([]);
  });
});
