// @module-tag int
// @module-tag platform
// @module-tag slow
import { aesGcmKek, kekIdOf, openSecret, sealSecret } from "../../utils/kek.js";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SYSTEM_USER_ID } from "../../definitions/systemUser.js";
import { execFile, execFileSync } from "child_process";
import { randomBytes, randomUUID } from "crypto";
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

const clearSecrets = () => db.query(`DELETE FROM "core"."secrets"`);

describe("resealRowSecrets", () => {
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

    it("re-encrypts secrets kept in table columns from CORE_KEK_PREVIOUS on start", async () => {
      const old = newKek();
      await runChild({ CORE_KEK: old.CORE_KEK });
      const oldKek = aesGcmKek(Buffer.from(old.CORE_KEK, "base64"), old.id);
      const providerId = randomUUID();
      const connectionId = randomUUID();
      await db.query(
        `INSERT INTO "auth"."identity_providers"
         (id, slug, display_name, kind, issuer, client_id, client_secret, created_by, updated_at)
       VALUES ($1, $2, 'IdP', 'oidc', 'https://idp.example.com', 'client', $3, $4, now())`,
        [
          providerId,
          `idp-${providerId.slice(0, 8)}`,
          await sealSecret(
            oldKek,
            `identity-provider:${providerId}`,
            "idp-secret"
          ),
          SYSTEM_USER_ID,
        ]
      );
      await db.query(
        `INSERT INTO "notifications"."connections"
         (id, channel, slug, display_name, settings, secrets, created_by, updated_by, updated_at)
       VALUES ($1, 'email', $2, 'SMTP', '{}', $3, $4, $4, now())`,
        [
          connectionId,
          `c-${connectionId.slice(0, 8)}`,
          await sealSecret(
            oldKek,
            `notification-connection:${connectionId}`,
            JSON.stringify({ password: "smtp-secret" })
          ),
          SYSTEM_USER_ID,
        ]
      );
      try {
        const kek = newKek();
        await runChild({
          CORE_KEK: kek.CORE_KEK,
          CORE_KEK_PREVIOUS: old.CORE_KEK,
          RESEAL_ROW_SECRETS: "1",
        });

        const current = aesGcmKek(Buffer.from(kek.CORE_KEK, "base64"), kek.id);
        const provider = await db.query<{ client_secret: string }>(
          `SELECT client_secret FROM "auth"."identity_providers" WHERE id = $1`,
          [providerId]
        );
        const connection = await db.query<{ secrets: string }>(
          `SELECT secrets FROM "notifications"."connections" WHERE id = $1`,
          [connectionId]
        );
        // Openable with the new KEK alone: the old one can go.
        expect(
          (
            await openSecret(
              current,
              `identity-provider:${providerId}`,
              provider.rows[0].client_secret
            )
          ).value
        ).toBe("idp-secret");
        expect(
          (
            await openSecret(
              current,
              `notification-connection:${connectionId}`,
              connection.rows[0].secrets
            )
          ).value
        ).toBe(JSON.stringify({ password: "smtp-secret" }));
      } finally {
        await db.query(
          `DELETE FROM "auth"."identity_providers" WHERE id = $1`,
          [providerId]
        );
        await db.query(
          `DELETE FROM "notifications"."connections" WHERE id = $1`,
          [connectionId]
        );
      }
    });
  });
});
