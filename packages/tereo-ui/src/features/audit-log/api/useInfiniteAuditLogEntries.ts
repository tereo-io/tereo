import type { UseInfiniteReturn } from "@kosmeo-ui/react";
import useCursorInfinite from "./useCursorInfinite";
import type { AuditLogEntry } from "../types";

/**
 * `GET /v1/audit/entries` — every entry visible to the caller, scoped by core
 * to the token's organization. Filters arrive as `filter[field]` /
 * `filter[field_op]` (see `listQuerySchema` in core); sort is `createdAt` only.
 */
const useInfiniteAuditLogEntries = (): UseInfiniteReturn<AuditLogEntry> =>
  useCursorInfinite("audit-log-entries", "/entries");

export default useInfiniteAuditLogEntries;
