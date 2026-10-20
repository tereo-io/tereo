import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SYSTEM_USER_ID } from "../../definitions/systemUser.js";
import { execFile, execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { Pool } from "pg";
import path from "path";
import {
  aesGcmKek,
  devKek,
  kekIdOf,
  openSecret,
  sealSecret,
} from "../../utils/kek.js";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "crypto";

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
const childScript = path.join(here, "loadKeysChild.ts");
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

  it("generates every key once, even when processes start together", async () => {
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
  });

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

  it("encrypts plaintext rows in place, once, when processes start together", async () => {
    // core.secrets as it was before the KEK: plaintext.
    await runChild();
    const plaintext = await Promise.all(
      (await rows()).map(async (row) => ({
        name: row.name,
        value: (await openSecret(devKek, row.name, row.value)).value,
      }))
    );
    for (const { name, value } of plaintext) {
      await db.query(`UPDATE "core"."secrets" SET value = $2 WHERE name = $1`, [
        name,
        value,
      ]);
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
    expect(wrapped.map((r) => r.name)).toEqual(plaintext.map((r) => r.name));
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
  });

  it("re-encrypts rows from the dev KEK once CORE_KEK is set", async () => {
    const dev = await runChild();
    const kek = newKek();

    const withKek = await runChild({ CORE_KEK: kek.CORE_KEK });

    expect(withKek).toEqual(dev);
    for (const row of await rows()) {
      expect(row.value).toMatch(new RegExp(`^kek1:${kek.id}:`));
    }
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

  it("re-encrypts rows from CORE_KEK_PREVIOUS under CORE_KEK, once, when processes start together", async () => {
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
    expect(wrapped.map((r) => r.name).sort()).toEqual([...KEY_NAMES].sort());
    for (const row of wrapped) {
      expect(row.value).toMatch(new RegExp(`^kek1:${kek.id}:`));
    }

    // Done: the next start changes nothing, and the old KEK can go.
    expect(await runChild(rotating)).toEqual(before);
    expect(await rows()).toEqual(wrapped);
    expect(await runChild({ CORE_KEK: kek.CORE_KEK })).toEqual(before);
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
      await db.query(`DELETE FROM "auth"."identity_providers" WHERE id = $1`, [
        providerId,
      ]);
      await db.query(
        `DELETE FROM "notifications"."connections" WHERE id = $1`,
        [connectionId]
      );
    }
  });

  it("refuses a row under neither CORE_KEK nor CORE_KEK_PREVIOUS", async () => {
    const written = newKek();
    await runChild({ CORE_KEK: written.CORE_KEK });
    const kek = newKek();
    const previous = newKek();

    await expect(
      runChild({ CORE_KEK: kek.CORE_KEK, CORE_KEK_PREVIOUS: previous.CORE_KEK })
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
