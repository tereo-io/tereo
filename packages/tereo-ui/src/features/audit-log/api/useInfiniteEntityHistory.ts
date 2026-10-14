import type { UseInfiniteReturn } from "@kosmeo-ui/react";
import useCursorInfinite from "./useCursorInfinite";
import type { AuditLogEntry } from "../types";

/**
 * `GET /v1/audit/entries/entity/:entityType/:entityId` — one entity's full
 * change history. Takes sort direction, limit and cursor, plus an organization
 * filter (an org id or `none`, audit-logs.admin only).
 */
const useInfiniteEntityHistory = (
  entityType: string,
  entityId: string,
  organizationFilter?: string | null
): UseInfiniteReturn<AuditLogEntry> =>
  useCursorInfinite(
    `audit-log-entity-${entityType}-${entityId}`,
    `/entries/entity/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`,
    !!entityType && !!entityId,
    organizationFilter
  );

export default useInfiniteEntityHistory;
