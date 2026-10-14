import type { OrgRef } from "@/lib/refs";

/**
 * Audit log entry as core returns it (`audit.audit_log_entries`, see
 * `packages/tereo/prisma/schema.prisma` → `AuditLogEntry`).
 */

export const AUDIT_ACTIONS = [
  "CREATE",
  "UPDATE",
  "DELETE",
  "MERGE",
  "ARCHIVE",
  "RESTORE",
  "LOGIN",
  "LOGOUT",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditLogChange {
  old?: unknown;
  new?: unknown;
}

/** A user core looked up for `userId` / `writerUserId`. */
export interface AuditLogActor {
  id: string;
  email: string;
  name: string | null;
}

/** `filter[organizationId]` value for entries that belong to no organization. */
export const SYSTEM_WIDE = "none";

export interface AuditLogEntry {
  id: string;
  /** Self-reported by the writing service (e.g. its namespace). */
  source: string;
  organizationId: string | null;
  /** The end user the entry was written on behalf of (self-reported). */
  userId: string;
  /** Self-reported alongside `userId`; `user` is what core resolved. */
  userEmail: string | null;
  user: AuditLogActor;
  action: AuditAction;
  entityType: string;
  entityId: string;
  entityName: string | null;
  changes: Record<string, AuditLogChange> | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  correlationId: string | null;
  /** The principal core actually authenticated when the entry was written. */
  writerUserId: string;
  writer: AuditLogActor;
  /** `null` for a system-wide entry. */
  organization: OrgRef | null;
  createdAt: string;
}

/** `GET /entries/facets` — distinct values for the filter dropdowns. */
export interface AuditLogFacets {
  sources: string[];
  entityTypes: string[];
  /** Top-level metadata keys of recent entries. */
  metadataKeys: string[];
}
