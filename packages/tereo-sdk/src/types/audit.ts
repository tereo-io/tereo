import type {
  AuditLogEntryWithNames,
  AuditLogAction,
  AuditLogWritableAction,
  AuditLogChanges,
  AuditLogEntry as TransportAuditLogEntry,
  AuditLogMetadata,
  PaginatedAuditLogEntries,
} from "../handler.js";

export interface AuditLogServiceClientConfig {
  /**
   * Logical service identifier embedded in every entry. Required so the
   * service-side `query()` can scope reads to entries this client wrote.
   */
  source: string;
}

/**
 * Caller-facing input shape for `log()` / `logAsync()`. `source` is injected
 * by the SDK from the constructor — callers must not provide it.
 */
export interface AuditLogEntryInput {
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
  /** Idempotency key, held in Redis for 24h per writer. */
  idempotencyKey?: string;
}

/** An entry as `logAsync` returns it. */
export type AuditLogResult = TransportAuditLogEntry;
/** An entry as the reads return it: `user`, `writer` and `organization` named. */
export type AuditLogReadResult = AuditLogEntryWithNames;
export type AuditLogQueryResult = PaginatedAuditLogEntries;

export type {
  AuditLogActor,
  AuditLogAction,
  AuditLogWritableAction,
  AuditLogChanges,
  AuditLogMetadata,
} from "../handler.js";

/** Options for `query()`. Mirrors the service's filter/sort surface. */
export interface AuditLogQueryOptions {
  limit?: number;
  /** Opaque cursor from the prior page's `nextCursor`. Omit for the first page. */
  cursor?: string;
  sort?: "createdAt";
  sortDir?: "asc" | "desc";
  filter?: {
    source?: { equals?: string; in?: string[] };
    /** An organization id, or `"none"` for system-wide entries (audit-logs.admin). */
    organizationId?: { equals?: string };
    userId?: { equals?: string };
    writerUserId?: { equals?: string };
    userEmail?: { equals?: string; contains?: string };
    action?: { equals?: AuditLogAction; in?: AuditLogAction[] };
    entityType?: { equals?: string; in?: string[] };
    entityId?: { equals?: string };
    entityName?: { contains?: string; equals?: string };
    ipAddress?: { equals?: string };
    correlationId?: { equals?: string };
    createdAt?: { gte?: string; lte?: string };
    /**
     * Case-insensitive text search over `entityName`, `changes` and
     * `metadata`. Core scans at most 31 days: without `createdAt.gte` it
     * searches the 31 days before `createdAt.lte` (or now), and refuses a
     * longer range with `400 search_window_too_large`.
     */
    q?: { equals?: string };
  };
  /** Filter by metadata key-value pairs (Prisma JSON path queries). */
  metadata?: Record<string, { equals?: string; contains?: string }>;
}

export interface AuditLogEntityQueryOptions {
  limit?: number;
  cursor?: string;
  sort?: "createdAt";
  sortDir?: "asc" | "desc";
  /**
   * `filter[organizationId]`: an organization id, or `"none"` for system-wide
   * entries. Naming any organization but the token's own needs
   * `audit-logs.admin` (otherwise core answers 403); without it, reads are
   * scoped to the token's `org_id`, and an admin token without one reads
   * every organization.
   */
  organizationId?: string;
}

/** Options for `queryByEntityOrMetadata()`. */
export interface QueryByEntityOrMetadataOptions {
  /** ID of the parent record (e.g., orderId, purchaseOrderId). */
  entityId: string;
  /** Metadata key that line/sub-entity entries write to (e.g., "orderId"). */
  metadataKey: string;
  limit?: number;
  cursor?: string;
  sortDir?: "asc" | "desc";
  filter?: AuditLogQueryOptions["filter"];
}

export interface AuditLogBatchResult {
  created: number;
}
