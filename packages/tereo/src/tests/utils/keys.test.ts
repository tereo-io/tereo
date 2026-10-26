// @module-tag int
// @module-tag platform
// @module-tag slow
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash, generateKeyPairSync, randomBytes } from "crypto";
import { devKek, kekIdOf, openSecret } from "../../utils/kek.js";
import { execFile, execFileSync } from "child_process";
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

const KEY_NAMES = [
  "JWT_SIGNING_KEY_V1",
  "TOTP_ENCRYPTION_KEY",
  "KNOWN_DEVICE_KEY",
  "CURSOR_SIGNING_KEY_V1",
  "FILE_SERVICE_SIGNING_KEY_V1",
  "FILE_SERVICE_MASTER_KEY_V1",
  "AUTH_CODE_HMAC_KEY",
];

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

const fingerprint = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

/** The child's fingerprint of a key, from the plaintext of its row. */
const rowFingerprint = (name: string, value: string) =>
  name === "FILE_SERVICE_MASTER_KEY_V1"
    ? fingerprint(Buffer.from(value, "base64"))
    : fingerprint(value);

const childKeyOf = (name: string) =>
  name === "JWT_SIGNING_KEY_V1" ? "JWT_PRIVATE_KEY" : name;

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

    it(
      "generates every key once, even when processes start together",
      { tags: ["race"] },
      async () => {
        const results = await Promise.all([runChild(), runChild(), runChild()]);

        expect(results[1]).toEqual(results[0]);
        expect(results[2]).toEqual(results[0]);

        const stored = await rows();
        expect(stored.map((r) => r.name).sort()).toEqual([...KEY_NAMES].sort());
        for (const row of stored) {
          // Outside production, without CORE_KEK: the dev KEK.
          expect(row.value).toMatch(/^kek1:dev:/);
          const { value } = await openSecret(devKek, row.name, row.value);
          expect(results[0][childKeyOf(row.name)]).toBe(
            rowFingerprint(row.name, value)
          );
        }
        // The kid is the public key's JWK thumbprint (43 base64url chars).
        expect(results[0].JWT_KEY_ID).toMatch(/^[A-Za-z0-9_-]{43}$/);
      }
    );

    it("reuses stored keys on the next start", async () => {
      const first = await runChild();
      const before = await rows();

      const second = await runChild();
      const after = await rows();

      expect(second).toEqual(first);
      expect(after).toEqual(before);
    });

    it("prefers a key from env and does not store it", async () => {
      const totp = randomBytes(32).toString("hex");

      const result = await runChild({ TOTP_ENCRYPTION_KEY: totp });

      expect(result.TOTP_ENCRYPTION_KEY).toBe(fingerprint(totp));
      const names = (await rows()).map((r) => r.name);
      expect(names).not.toContain("TOTP_ENCRYPTION_KEY");
      expect(names).toContain("JWT_SIGNING_KEY_V1");
    });

    it("uses a JWT key pair from env as the only signing key", async () => {
      const { privateKey, publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });

      const result = await runChild({
        JWT_PRIVATE_KEY: Buffer.from(privateKey).toString("base64"),
        JWT_PUBLIC_KEY: Buffer.from(publicKey).toString("base64"),
      });

      expect(result.JWT_PRIVATE_KEY).toBe(fingerprint(privateKey));
      const names = (await rows()).map((r) => r.name);
      expect(names.some((n) => n.startsWith("JWT_"))).toBe(false);
    });

    it(
      "encrypts plaintext rows in place, once, when processes start together",
      { tags: ["race"] },
      async () => {
        // core.secrets as it was before the KEK: plaintext.
        await runChild();
        const plaintext = await Promise.all(
          (await rows()).map(async (row) => ({
            name: row.name,
            value: (await openSecret(devKek, row.name, row.value)).value,
          }))
        );
        for (const { name, value } of plaintext) {
          await db.query(
            `UPDATE "core"."secrets" SET value = $2 WHERE name = $1`,
            [name, value]
          );
        }
        const kek = newKek();

        const results = await Promise.all([
          runChild({ CORE_KEK: kek.CORE_KEK }),
          runChild({ CORE_KEK: kek.CORE_KEK }),
          runChild({ CORE_KEK: kek.CORE_KEK }),
        ]);

        expect(results[1]).toEqual(results[0]);
        expect(results[2]).toEqual(results[0]);
        const wrapped = await rows();
        expect(wrapped.map((r) => r.name)).toEqual(
          plaintext.map((r) => r.name)
        );
        for (const row of wrapped) {
          expect(row.value).toMatch(new RegExp(`^kek1:${kek.id}:`));
          const original = plaintext.find((p) => p.name === row.name)!.value;
          expect(row.value).not.toContain(original);
          expect(results[0][childKeyOf(row.name)]).toBe(
            rowFingerprint(row.name, original)
          );
        }

        // Already encrypted: the next start leaves every row alone.
        expect(await runChild({ CORE_KEK: kek.CORE_KEK })).toEqual(results[0]);
        expect(await rows()).toEqual(wrapped);
      }
    );

    it("re-encrypts rows from the dev KEK once CORE_KEK is set", async () => {
      const dev = await runChild();
      const kek = newKek();

      const withKek = await runChild({ CORE_KEK: kek.CORE_KEK });

      expect(withKek).toEqual(dev);
      for (const row of await rows()) {
        expect(row.value).toMatch(new RegExp(`^kek1:${kek.id}:`));
      }
    });

    it(
      "re-encrypts rows from CORE_KEK_PREVIOUS under CORE_KEK, once, when processes start together",
      { tags: ["race"] },
      async () => {
        const old = newKek();
        const before = await runChild({ CORE_KEK: old.CORE_KEK });
        const kek = newKek();
        const rotating = {
          CORE_KEK: kek.CORE_KEK,
          CORE_KEK_PREVIOUS: old.CORE_KEK,
        };

        const results = await Promise.all([
          runChild(rotating),
          runChild(rotating),
          runChild(rotating),
        ]);

        for (const result of results) expect(result).toEqual(before);
        const wrapped = await rows();
        expect(wrapped.map((r) => r.name).sort()).toEqual(
          [...KEY_NAMES].sort()
        );
        for (const row of wrapped) {
          expect(row.value).toMatch(new RegExp(`^kek1:${kek.id}:`));
        }

        // Done: the next start changes nothing, and the old KEK can go.
        expect(await runChild(rotating)).toEqual(before);
        expect(await rows()).toEqual(wrapped);
        expect(await runChild({ CORE_KEK: kek.CORE_KEK })).toEqual(before);
      }
    );
  });

  describe("Signing keys supplied in env", () => {
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
            env: {
              ...baseEnv,
              ...extraEnv,
              NODE_OPTIONS: "",
              LOG_LEVEL: "silent",
            },
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

    /**
     * Presign and cursor signing keys supplied in env, at any version, loaded by
     * a child process against a database of its own.
     */

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
});
