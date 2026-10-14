/**
 * What the outbox needs from the app's database client: raw SQL with
 * positional parameters (`$1`, `$2`, …). A Prisma client and a Prisma
 * transaction client both qualify, as does a thin wrapper over `pg`.
 */
export interface SqlClient {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface OutboxOptions {
  /** The app's database client, used by the reaper outside any transaction. */
  db: SqlClient;
  /**
   * The outbox table, optionally schema-qualified: `core_outbox` (default) or
   * `billing.core_outbox`. Create it with `outboxTableSql` or the Prisma model in
   * docs/outbox.md.
   */
  table?: string;
  /** Run the reaper in this process. Default true; turn off for API-only replicas. */
  dispatch?: boolean;
  pollIntervalMs?: number;
  batchSize?: number;
  /** After this many failed attempts a row is dead-lettered and kept for replay. Default 100. */
  maxAttempts?: number;
  retryBaseMs?: number;
  maxBackoffMs?: number;
  /** A claim older than this may be taken by another worker. Renewed per row, so it bounds one row's dispatch. Default 5 min. */
  claimTtlMs?: number;
}

/** One row of the outbox table, as the reaper reads it. */
export interface OutboxRow {
  id: string;
  destination: "audit" | "webhook" | string;
  payload: unknown;
  traceparent: string | null;
  tracestate: string | null;
  created_at: Date;
  next_attempt_at: Date;
  claimed_at: Date | null;
  claimed_by: string | null;
  attempts: number;
  last_error: string | null;
  dead_lettered_at: Date | null;
}
