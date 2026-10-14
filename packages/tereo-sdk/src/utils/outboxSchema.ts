// The outbox table lives in the app's own database, created by the app's own
// migrations. These are its definition, for a SQL migration or Prisma.

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * `core_outbox` or `schema.core_outbox` → a quoted SQL identifier. Only plain
 * lowercase names are accepted: the name is interpolated into SQL.
 */
export const quoteTable = (table: string): string => {
  const parts = table.split(".");
  if (parts.length > 2 || !parts.every((p) => IDENTIFIER.test(p))) {
    throw new Error(
      `@tereo-io/sdk: outbox table "${table}" must be lowercase letters, digits and _, optionally schema-qualified`
    );
  }
  return parts.map((p) => `"${p}"`).join(".");
};

/** `CREATE TABLE` and index for the outbox, for a SQL migration. */
export const outboxTableSql = (table = "core_outbox"): string => {
  const quoted = quoteTable(table);
  const index = `"${table.split(".").pop()}_pending_idx"`;
  return `CREATE TABLE ${quoted} (
    "id" UUID NOT NULL PRIMARY KEY,
    "destination" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "traceparent" VARCHAR(64),
    "tracestate" VARCHAR(512),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "claimed_by" VARCHAR(255),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(1000),
    "dead_lettered_at" TIMESTAMP(3)
);
CREATE INDEX ${index} ON ${quoted} ("next_attempt_at") WHERE "dead_lettered_at" IS NULL;
`;
};
