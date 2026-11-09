// @module-tag int
// @module-tag platform
// @module-tag slow
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";
import pg from "pg";

// The user_links migration against a database holding accounts from before it.

const MIGRATION = "20261108120000_user_links";
const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../prisma/migrations"
);

const scratchName = `${new URL(process.env.DATABASE_URL!).pathname.slice(1)}_migration_${randomUUID().slice(0, 8)}`;
const scratchUrl = () => {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${scratchName}`;
  return url.toString();
};

const migrationSql = async (name: string) =>
  readFile(path.join(migrationsDir, name, "migration.sql"), "utf8");

/**
 * The script's statements, one by one: as one multi-statement query they would
 * share a transaction, which a new enum value may not be used in.
 */
const statements = (sql: string): string[] => {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
    } else if (rest.startsWith("/*")) {
      i = sql.indexOf("*/", i + 2) + 2;
    } else if (sql[i] === "'" || sql[i] === '"') {
      i = sql.indexOf(sql[i], i + 1) + 1;
    } else if (/^\$\w*\$/.test(rest)) {
      const tag = /^\$\w*\$/.exec(rest)![0];
      i = sql.indexOf(tag, i + tag.length) + tag.length;
    } else if (sql[i] === ";") {
      out.push(sql.slice(start, i));
      start = ++i;
    } else {
      i++;
    }
  }
  out.push(sql.slice(start));
  return out.filter((s) => s.replace(/--.*$/gm, "").trim() !== "");
};

const runScript = async (client: pg.Client, name: string) => {
  for (const statement of statements(await migrationSql(name))) {
    await client.query(statement);
  }
};

describe(`migration ${MIGRATION}`, () => {
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  let scratch: pg.Client;

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${scratchName}"`);
    scratch = new pg.Client({ connectionString: scratchUrl() });
    await scratch.connect();
    const earlier = (await readdir(migrationsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name < MIGRATION)
      .map((e) => e.name)
      .sort();
    for (const name of earlier) await runScript(scratch, name);
  }, 60_000);

  afterAll(async () => {
    await scratch?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${scratchName}"`);
    await admin.end();
  });

  it("marks existing people verified, never service accounts", async () => {
    const insert = (userType: string, expiresAt: Date | null) =>
      scratch
        .query<{ id: string }>(
          `INSERT INTO "auth"."users" ("id", "email", "user_type", "expires_at", "updated_at")
           VALUES ($1::uuid, $2, $3::"auth"."user_type", $4, now()) RETURNING "id"`,
          [
            randomUUID(),
            `${userType}-${randomUUID()}@test.local`,
            userType,
            expiresAt,
          ]
        )
        .then((r) => r.rows[0].id);
    const human = await insert("human", null);
    const guest = await insert("guest", new Date(Date.now() + 86_400_000));
    const service = await insert("service_account", null);

    await runScript(scratch, MIGRATION);

    const { rows } = await scratch.query<{
      id: string;
      email_verified_at: Date | null;
    }>(
      `SELECT "id", "email_verified_at" FROM "auth"."users" WHERE "id" = ANY($1::uuid[])`,
      [[human, guest, service]]
    );
    const verifiedAt = new Map(rows.map((r) => [r.id, r.email_verified_at]));
    expect(verifiedAt.get(human)).toBeInstanceOf(Date);
    expect(verifiedAt.get(guest)).toBeInstanceOf(Date);
    expect(verifiedAt.get(service)).toBeNull();

    const { rows: columns } = await scratch.query<{ data_type: string }>(
      `SELECT "data_type" FROM "information_schema"."columns"
       WHERE "table_schema" = 'auth' AND "table_name" = 'users' AND "column_name" = 'email_verified_at'`
    );
    expect(columns[0].data_type).toBe("timestamp without time zone");
  });
});
