// @module-tag int
// @module-tag platform
// @module-tag slow
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { generateKeyPairSync, randomBytes } from "crypto";
import { execFile, execFileSync } from "child_process";
import { kekIdOf } from "../../utils/kek.js";
import { mkdtempSync, rmSync } from "fs";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { Pool } from "pg";
import path from "path";

/**
 * Key generation and the KEK, exercised in child processes so each starts
 * from nothing but env and the database. They run against a database of
 * their own, created and migrated here and dropped afterwards, so the
 * suite's `core.secrets` (and the keys the server loaded) are never touched.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

const packageRoot = path.resolve(here, "../../..");

const childScript = path.join(here, "../fixtures/loadKeysChild.ts");

const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");

// No `.env` in the child's working directory, so dotenv adds nothing back.
const workDir = mkdtempSync(path.join(tmpdir(), "core-keys-"));

const suiteDbUrl = new URL(process.env.DATABASE_URL!);

const isolatedDbName = `${suiteDbUrl.pathname.slice(1)}_keys`;

const isolatedDbUrl = new URL(suiteDbUrl);
isolatedDbUrl.pathname = `/${isolatedDbName}`;

const keyEnvPattern =
  /^(JWT_(PRIVATE_KEY|PUBLIC_KEY|KEY_ID)|TOTP_ENCRYPTION_KEY|\w+_SIGNING_KEY_V\d+|FILE_SERVICE_MASTER_KEY_V\d+|CORE_KEK(_PREVIOUS)?|AUTH_CODE_HMAC_KEY|KNOWN_DEVICE_KEY)$/;

const baseEnv = {
  ...(Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => value !== undefined && !keyEnvPattern.test(name)
    )
  ) as Record<string, string>),
  DATABASE_URL: isolatedDbUrl.toString(),
};

type Fingerprints = Record<string, string>;

const runChild = (extraEnv: Record<string, string> = {}) =>
  new Promise<Fingerprints>((resolve, reject) => {
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

const newKek = () => {
  const key = randomBytes(32);
  return { CORE_KEK: key.toString("base64"), id: kekIdOf(key) };
};

let db: Pool;

const rows = async () =>
  (
    await db.query<{ name: string; value: string }>(
      `SELECT name, value FROM "core"."secrets" ORDER BY name`
    )
  ).rows;

const clearSecrets = () => db.query(`DELETE FROM "core"."secrets"`);

describe("loadKeys", () => {
  describe("Generated keys", () => {
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
    });

    afterAll(async () => {
      // `end()` resolves before its connections have closed, so the forced drop
      // below can kill one still closing, and the pool re-emits that error.
      db?.on("error", () => {});
      await db?.end();
      const admin = new Pool({ connectionString: suiteDbUrl.toString() });
      await admin
        .query(`DROP DATABASE IF EXISTS "${isolatedDbName}" WITH (FORCE)`)
        .finally(() => admin.end());
      rmSync(workDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
      await clearSecrets();
    });

    it("refuses a JWT key pair from env under 2048 bits", async () => {
      const { privateKey, publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 1024,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });

      await expect(
        runChild({
          JWT_PRIVATE_KEY: Buffer.from(privateKey).toString("base64"),
          JWT_PUBLIC_KEY: Buffer.from(publicKey).toString("base64"),
        })
      ).rejects.toThrow(/at least 2048 bits/);
    });

    it("refuses half of the JWT key pair", async () => {
      const { publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });

      await expect(
        runChild({
          JWT_PUBLIC_KEY: Buffer.from(publicKey).toString("base64"),
        })
      ).rejects.toThrow(/must be supplied together/);
    });

    it("refuses to start with a different KEK than the rows were written with", async () => {
      const kek = newKek();
      await runChild({ CORE_KEK: kek.CORE_KEK });
      const other = newKek();

      await expect(runChild({ CORE_KEK: other.CORE_KEK })).rejects.toThrow(
        new RegExp(`encrypted with KEK ${kek.id}.*has KEK ${other.id}`)
      );
      // And without one, outside production, likewise: the dev KEK is not it.
      await expect(runChild()).rejects.toThrow(/encrypted with KEK/);
    });

    it("refuses a row under neither CORE_KEK nor CORE_KEK_PREVIOUS", async () => {
      const written = newKek();
      await runChild({ CORE_KEK: written.CORE_KEK });
      const kek = newKek();
      const previous = newKek();

      await expect(
        runChild({
          CORE_KEK: kek.CORE_KEK,
          CORE_KEK_PREVIOUS: previous.CORE_KEK,
        })
      ).rejects.toThrow(
        new RegExp(
          `encrypted with KEK ${written.id}.*has KEK ${kek.id} \\(and previous ${previous.id}\\)`
        )
      );
      expect(
        (await rows()).every((r) => r.value.startsWith(`kek1:${written.id}:`))
      ).toBe(true);
    });

    it("refuses CORE_KEK_PREVIOUS without CORE_KEK", async () => {
      await expect(
        runChild({ CORE_KEK_PREVIOUS: newKek().CORE_KEK })
      ).rejects.toThrow(/CORE_KEK_PREVIOUS needs CORE_KEK/);
    });

    it("refuses to start in production without CORE_KEK", async () => {
      await expect(
        runChild({
          NODE_ENV: "production",
          PUBLIC_URL: "https://core.example.com",
          CORS_ALLOWED_ORIGINS: "https://app.example.com",
        })
      ).rejects.toThrow(/CORE_KEK is required in production/);
      expect(await rows()).toEqual([]);
    });
  });
});
