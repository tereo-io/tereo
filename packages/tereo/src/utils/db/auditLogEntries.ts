import { Prisma } from "../../../prisma/generated/client/index.js";
import { orgRefSelect, userRefSelect } from "../refs.js";
import { runPartitionDdl } from "./partitionDdl.js";
import { GetPaginatedOptions } from "./types.js";
import { NotFoundError } from "../errors.js";
import { escapeLike } from "./like.js";
import { prisma } from "./prisma.js";

export interface CreateEntryInput {
  source: string;
  organizationId?: string | null;
  userId: string;
  userEmail?: string | null;
  action: "CREATE" | "UPDATE" | "DELETE" | "MERGE" | "ARCHIVE" | "RESTORE";
  entityType: string;
  entityId: string;
  entityName?: string;
  changes?: Record<string, { old?: unknown; new?: unknown }>;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  correlationId?: string;
  // Server-set from the authenticated token, never the caller. See schema.
  writerUserId: string;
}

// Prisma loads each relation with one batched `IN` query per page, not per row.
const withNames = {
  user: userRefSelect,
  writer: userRefSelect,
  organization: orgRefSelect,
} satisfies Prisma.AuditLogEntryInclude;

/** Limits a read to the entries one writer made under one source. */
export interface EntryScope {
  source: string;
  writerUserId: string;
}

/**
 * `organizationId`: an id, `null` for system-wide entries, `undefined` for any.
 * `scope`: only an entry within it.
 */
export const findById = async (
  id: string,
  organizationId?: string | null,
  scope?: EntryScope
) => {
  return await prisma.auditLogEntry.findFirst({
    where: { id, organizationId, ...scope },
    include: withNames,
  });
};

export const getById = async (
  id: string,
  organizationId?: string | null,
  scope?: EntryScope
) => {
  const entry = await findById(id, organizationId, scope);
  if (!entry) throw new NotFoundError("Audit log entry not found");
  return entry;
};

export const getPaginated = async (options: GetPaginatedOptions) => {
  const { take, orderBy, where: filterWhere } = options;
  const where = filterWhere ?? {};

  const rows = await prisma.auditLogEntry.findMany({
    where,
    take: take + 1,
    orderBy,
    include: withNames,
  });

  const hasMore = rows.length > take;
  const data = hasMore ? rows.slice(0, take) : rows;

  return { data, hasMore };
};

// ============================================
// TEXT SEARCH
// ============================================

// Prisma cannot match text inside a JSON document — its pathless JSON
// `string_contains` only matches documents that are themselves strings — so a
// search page is chosen in SQL, from the same `where` the list builds for
// Prisma (filters plus cursor), then loaded through Prisma.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SEARCH_COLUMNS: Record<
  string,
  { sql: Prisma.Sql; cast?: "uuid" | "timestamp" }
> = {
  id: { sql: Prisma.raw(`"id"`), cast: "uuid" },
  source: { sql: Prisma.raw(`"source"`) },
  organizationId: { sql: Prisma.raw(`"organization_id"`), cast: "uuid" },
  userId: { sql: Prisma.raw(`"user_id"`), cast: "uuid" },
  userEmail: { sql: Prisma.raw(`"user_email"`) },
  writerUserId: { sql: Prisma.raw(`"writer_user_id"`), cast: "uuid" },
  action: { sql: Prisma.raw(`"action"::text`) },
  entityType: { sql: Prisma.raw(`"entity_type"`) },
  entityId: { sql: Prisma.raw(`"entity_id"`) },
  entityName: { sql: Prisma.raw(`"entity_name"`) },
  ipAddress: { sql: Prisma.raw(`"ip_address"`) },
  correlationId: { sql: Prisma.raw(`"correlation_id"`) },
  createdAt: { sql: Prisma.raw(`"created_at"`), cast: "timestamp" },
};

const TRUE = Prisma.sql`TRUE`;
const FALSE = Prisma.sql`FALSE`;
const COMPARISONS: Record<string, string> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

type Spec = (typeof SEARCH_COLUMNS)[string];

// `created_at` is a timestamp without time zone holding UTC, and Postgres
// ignores the zone in an ISO string cast to one.
const param = (spec: Spec, value: unknown): Prisma.Sql => {
  const text = value instanceof Date ? value.toISOString() : String(value);
  return spec.cast
    ? Prisma.sql`${text}::${Prisma.raw(spec.cast)}`
    : Prisma.sql`${text}`;
};

// A value that is not a uuid can never equal a uuid column; casting it would
// fail the whole query instead.
const comparable = (spec: Spec, value: unknown) =>
  spec.cast !== "uuid" || (typeof value === "string" && UUID_RE.test(value));

const compileField = (field: string, filter: unknown): Prisma.Sql => {
  const spec = SEARCH_COLUMNS[field];
  if (!spec) throw new Error(`Search cannot filter on "${field}"`);
  if (filter === null) return Prisma.sql`${spec.sql} IS NULL`;
  if (typeof filter !== "object" || filter instanceof Date) {
    return compileField(field, { equals: filter });
  }

  const { mode, ...ops } = filter as Record<string, unknown>;
  const parts = Object.entries(ops).map(([op, value]): Prisma.Sql => {
    if (op === "equals") {
      if (value === null) return Prisma.sql`${spec.sql} IS NULL`;
      if (!comparable(spec, value)) return FALSE;
      // Prisma's case-insensitive equals is ILIKE on the value as given, so
      // the caller escapes it (see `userEmail` in the entries' filters).
      if (mode === "insensitive") {
        return Prisma.sql`${spec.sql} ILIKE ${param(spec, value)}`;
      }
      return Prisma.sql`${spec.sql} = ${param(spec, value)}`;
    }
    if (op === "in") {
      const values = (value as unknown[]).filter((v) => comparable(spec, v));
      if (values.length === 0) return FALSE;
      const list = Prisma.join(values.map((v) => param(spec, v)));
      return Prisma.sql`${spec.sql} IN (${list})`;
    }
    // Already escaped by the filter parser, which Prisma's own contains needs.
    if (op === "contains") {
      const like = Prisma.raw(mode === "insensitive" ? "ILIKE" : "LIKE");
      return Prisma.sql`${spec.sql} ${like} ${`%${String(value)}%`}`;
    }
    if (COMPARISONS[op]) {
      const cmp = Prisma.raw(COMPARISONS[op]);
      return Prisma.sql`${spec.sql} ${cmp} ${param(spec, value)}`;
    }
    throw new Error(`Search cannot apply "${op}" to "${field}"`);
  });
  return parts.length > 0 ? Prisma.join(parts, " AND ") : TRUE;
};

// The `metadata[key_equals|contains]` conditions, with Prisma's meaning:
// `equals` compares the value as a JSON string, `string_contains` matches
// inside a string value only, its value a LIKE pattern escaped by the caller.
const compileMetadata = (filter: Record<string, unknown>): Prisma.Sql => {
  const path = Prisma.sql`ARRAY[${Prisma.join(filter.path as string[])}]::text[]`;
  if ("equals" in filter) {
    return Prisma.sql`("metadata" #> ${path}) = to_jsonb(${String(filter.equals)}::text)`;
  }
  if ("string_contains" in filter) {
    const pattern = `%${String(filter.string_contains)}%`;
    return Prisma.sql`(jsonb_typeof("metadata" #> ${path}) = 'string' AND ("metadata" #>> ${path}) LIKE ${pattern})`;
  }
  throw new Error("Search cannot apply this metadata filter");
};

const compileWhere = (where: Record<string, unknown>): Prisma.Sql => {
  const parts: Prisma.Sql[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (key === "AND") {
      parts.push(...(value as Record<string, unknown>[]).map(compileWhere));
    } else if (key === "OR") {
      const any = (value as Record<string, unknown>[]).map(compileWhere);
      parts.push(any.length > 0 ? Prisma.join(any, " OR ") : FALSE);
    } else if (key === "metadata") {
      parts.push(compileMetadata(value as Record<string, unknown>));
    } else {
      parts.push(compileField(key, value));
    }
  }
  if (parts.length === 0) return TRUE;
  return Prisma.sql`(${Prisma.join(
    parts.map((p) => Prisma.sql`(${p})`),
    " AND "
  )})`;
};

/**
 * A page of the entries matching `where` whose entity name, `changes` or
 * `metadata` contains `q` (case-insensitive; JSON keys match too). Each JSON
 * document is matched as text, so the caller bounds the scan — the list
 * endpoint requires a `createdAt` window. Sorts by `createdAt` only.
 */
export const searchPaginated = async (
  options: GetPaginatedOptions & { q: string }
) => {
  const { take, orderBy, where, q } = options;
  const [primary] = orderBy;
  if (!primary || !("createdAt" in primary)) {
    throw new Error("Search sorts by createdAt only");
  }
  const dir = Prisma.raw(primary.createdAt === "asc" ? "ASC" : "DESC");
  const pattern = `%${escapeLike(q)}%`;
  // `jsonb::text` is JSON: a `"`, `\` or control character in a value is
  // escaped there, so the value is also looked for in that form.
  const jsonPattern = `%${escapeLike(JSON.stringify(q).slice(1, -1))}%`;
  const inJson = (column: Prisma.Sql) =>
    jsonPattern === pattern
      ? Prisma.sql`${column}::text ILIKE ${pattern}`
      : Prisma.sql`(${column}::text ILIKE ${pattern} OR ${column}::text ILIKE ${jsonPattern})`;

  const matches = await prisma.$queryRaw<{ id: string; created_at: string }[]>`
    SELECT "id",
           to_char("created_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "created_at"
    FROM "audit"."audit_log_entries"
    WHERE ${compileWhere(where ?? {})}
      AND ("entity_name" ILIKE ${pattern}
        OR ${inJson(Prisma.raw('"changes"'))}
        OR ${inJson(Prisma.raw('"metadata"'))})
    ORDER BY "created_at" ${dir}, "id" ASC
    LIMIT ${take + 1}
  `;
  if (matches.length === 0) return { data: [], hasMore: false };

  // The time bounds let Postgres skip every partition outside the page.
  const times = matches.map((m) => m.created_at).sort();
  const rows = await prisma.auditLogEntry.findMany({
    where: {
      id: { in: matches.map((m) => m.id) },
      createdAt: { gte: new Date(times[0]), lte: new Date(times.at(-1)!) },
    },
    orderBy,
    include: withNames,
  });

  return { data: rows.slice(0, take), hasMore: rows.length > take };
};

const METADATA_KEY_SAMPLE_ROWS = 5000;
const METADATA_KEY_LIMIT = 200;

/** The `createdAt` range facets are drawn from; it bounds the partitions read. */
export interface FacetWindow {
  gte: Date;
  lte?: Date;
}

/**
 * Distinct top-level metadata keys, sampled from the most recent entries in
 * the window (at most `METADATA_KEY_SAMPLE_ROWS` with metadata) so the cost
 * stays flat as the log grows.
 */
const getMetadataKeys = async (
  organizationId: string | null | undefined,
  createdAt: FacetWindow,
  scope?: EntryScope
) => {
  const rows = await prisma.$queryRaw<{ key: string }[]>`
    SELECT DISTINCT k."key"
    FROM (
      SELECT "metadata" FROM "audit"."audit_log_entries"
      WHERE ${compileWhere({ organizationId, createdAt, ...scope })}
        AND jsonb_typeof("metadata") = 'object'
      ORDER BY "created_at" DESC
      LIMIT ${METADATA_KEY_SAMPLE_ROWS}
    ) recent
    CROSS JOIN LATERAL jsonb_object_keys(recent."metadata") AS k("key")
    ORDER BY k."key"
    LIMIT ${METADATA_KEY_LIMIT}
  `;
  return rows.map((row) => row.key);
};

/**
 * Facets of the entries created in `createdAt`, the caller's date window, and
 * within `scope` when given.
 */
export const getFacets = async (
  organizationId: string | null | undefined,
  createdAt: FacetWindow,
  scope?: EntryScope
) => {
  const where = { organizationId, createdAt, ...scope };
  const [sources, entityTypes, metadataKeys] = await Promise.all([
    prisma.auditLogEntry.groupBy({
      by: ["source"],
      where,
      orderBy: { source: "asc" },
    }),
    prisma.auditLogEntry.groupBy({
      by: ["entityType"],
      where,
      orderBy: { entityType: "asc" },
    }),
    getMetadataKeys(organizationId, createdAt, scope),
  ]);
  return {
    sources: sources.map((row) => row.source),
    entityTypes: entityTypes.map((row) => row.entityType),
    metadataKeys,
  };
};

export const create = async (input: CreateEntryInput) => {
  return await prisma.auditLogEntry.create({
    data: {
      source: input.source,
      organizationId: input.organizationId ?? null,
      userId: input.userId,
      userEmail: input.userEmail ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      entityName: input.entityName,
      changes: input.changes as Prisma.InputJsonValue | undefined,
      metadata: input.metadata as Prisma.InputJsonValue | undefined,
      ipAddress: input.ipAddress ?? null,
      correlationId: input.correlationId,
      writerUserId: input.writerUserId,
    },
  });
};

export const createMany = async (inputs: CreateEntryInput[]) => {
  const data = inputs.map((input) => ({
    source: input.source,
    organizationId: input.organizationId ?? null,
    userId: input.userId,
    userEmail: input.userEmail ?? null,
    action: input.action as
      "CREATE" | "UPDATE" | "DELETE" | "MERGE" | "ARCHIVE" | "RESTORE",
    entityType: input.entityType,
    entityId: input.entityId,
    entityName: input.entityName,
    changes: input.changes as Prisma.InputJsonValue | undefined,
    metadata: input.metadata as Prisma.InputJsonValue | undefined,
    ipAddress: input.ipAddress ?? null,
    correlationId: input.correlationId,
    writerUserId: input.writerUserId,
  }));

  const result = await prisma.auditLogEntry.createMany({ data });
  return { created: result.count };
};

// No deleteById: audit entries are immutable and never individually removable.
// Lifecycle is partition-based retention only (see jobs/entryRetention.ts).

// ============================================
// PARTITION MANAGEMENT
// ============================================

export const listPartitions = async () => {
  return await prisma.$queryRaw<{ child: string }[]>`
    SELECT c.relname AS child
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'audit' AND p.relname = 'audit_log_entries'
    ORDER BY c.relname
  `;
};

const PARTITION_NAME_RE = /^audit_log_entries_\d{4}_\d{2}_\d{2}$/;
const DATE_STR_RE = /^\d{4}-\d{2}-\d{2}$/;

function validatePartitionName(name: string): void {
  if (!PARTITION_NAME_RE.test(name)) {
    throw new Error(`Invalid partition name: ${name}`);
  }
}

function validateDateStr(date: string): void {
  if (!DATE_STR_RE.test(date)) {
    throw new Error(`Invalid date string: ${date}`);
  }
}

/** False when the parent stayed locked; the partition is left for next time. */
export const dropPartition = async (partitionName: string) => {
  validatePartitionName(partitionName);
  return await runPartitionDdl([
    `DROP TABLE IF EXISTS "audit"."${partitionName}"`,
  ]);
};

/** False when the parent stayed locked; nothing is created. */
export const createPartition = async (
  name: string,
  from: string,
  to: string
) => {
  validatePartitionName(name);
  validateDateStr(from);
  validateDateStr(to);
  return await runPartitionDdl([
    `CREATE TABLE IF NOT EXISTS "audit"."${name}" PARTITION OF "audit"."audit_log_entries" FOR VALUES FROM ('${from}') TO ('${to}')`,
  ]);
};
