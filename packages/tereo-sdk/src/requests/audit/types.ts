// =============================================================================
// Shared types for the audit request module
// =============================================================================

import type { OrgRef } from "../refs.js";

/** The actions an app service may write. */
export type AuditLogWritableAction =
  "CREATE" | "UPDATE" | "DELETE" | "MERGE" | "ARCHIVE" | "RESTORE";

/**
 * The actions an entry can carry: what services write, plus `LOGIN` and
 * `LOGOUT`, which only core records (a user signing in or out).
 */
export type AuditLogAction = AuditLogWritableAction | "LOGIN" | "LOGOUT";

/**
 * Mutable change set: per-field old/new values produced by `computeChanges`.
 * Each side is optional — a CREATE diff carries only `new`, a DELETE only
 * `old`, and `computeChanges` emits `undefined` for the absent side which JSON
 * serialization (the outbox JSONB column) drops entirely.
 */
export type AuditLogChanges = Record<string, { old?: unknown; new?: unknown }>;

/**
 * Free-form, service-specific JSON payload attached to an entry.
 * Core's audit API supports JSON path filters over this field.
 */
export type AuditLogMetadata = Record<string, unknown>;

/**
 * Input shape for `POST /v1/audit/entries`. Mirrors the body core validates
 * via `entryFieldsSchema`. `source` is injected by the SDK.
 */
export interface CreateEntryInput {
  source: string;
  organizationId?: string | null;
  userId: string;
  userEmail?: string | null;
  action: AuditLogWritableAction;
  entityType: string;
  entityId: string;
  entityName?: string;
  changes?: AuditLogChanges;
  metadata?: AuditLogMetadata;
  ipAddress?: string | null;
  correlationId?: string;
  /** Optional idempotency key, held in Redis for 24h per writer. */
  idempotencyKey?: string;
}

/** Persisted entry returned by the service (read shape). */
export interface AuditLogEntry {
  id: string;
  source: string;
  organizationId: string | null;
  userId: string;
  userEmail: string | null;
  action: AuditLogAction;
  entityType: string;
  entityId: string;
  entityName: string | null;
  changes: AuditLogChanges | null;
  metadata: AuditLogMetadata | null;
  ipAddress: string | null;
  correlationId: string | null;
  /**
   * The user core authenticated when the entry was written (a client's
   * service-account user, or core's system user); unlike `userId`, never
   * self-reported.
   */
  writerUserId: string;
  createdAt: string;
}

/** A user named on an entry, looked up by core. */
export interface AuditLogActor {
  id: string;
  email: string;
  name: string | null;
}

/** An entry as the read endpoints return it, with its users and organization named. */
export interface AuditLogEntryWithNames extends AuditLogEntry {
  user: AuditLogActor;
  writer: AuditLogActor;
  /** `null` for a system-wide entry. */
  organization: OrgRef | null;
}

export interface CreateBatchInput {
  entries: Array<Omit<CreateEntryInput, "idempotencyKey">>;
  idempotencyKey?: string;
}

export interface CreateBatchResult {
  created: number;
}

/**
 * Cursor-paginated query result. Cursors are HMAC-signed by the service —
 * pass `nextCursor` from the previous page on subsequent calls.
 */
export interface PaginatedAuditLogEntries {
  data: AuditLogEntryWithNames[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}

export interface ListEntriesParams {
  limit?: number;
  cursor?: string;
  sort?: "createdAt";
  sortDir?: "asc" | "desc";
  /**
   * Bracketed `filter[field]=value` / `filter[field_op]=in|contains|equals|...`
   * params are passed flat — the SDK builds them from the structured options
   * exposed on `AuditLogServiceClient.query()`.
   */
  [key: string]: string | number | undefined;
}

export interface GetByEntityParams {
  limit?: number;
  cursor?: string;
  sort?: "createdAt";
  sortDir?: "asc" | "desc";
  "filter[source]"?: string;
  "filter[organizationId]"?: string;
}
