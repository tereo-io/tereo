import { useInfiniteCursor, type UseInfiniteReturn } from "@kosmeo-ui/react";
import { METADATA_FILTER } from "../utils/urlFilters";
import { useAuth, useAxios } from "@/lib/auth";
import type { AuditLogEntry } from "../types";
import { useCallback } from "react";

/**
 * Filters core accepts only with `equals`. `InfiniteScroll` sends every
 * SEARCH filter with `_op=contains`, which core rejects for these fields, so
 * the operator is dropped (core then defaults to `equals`).
 */
const EQUALS_ONLY_FIELDS = [
  "q",
  "userId",
  "writerUserId",
  "entityId",
  "correlationId",
  "ipAddress",
  "organizationId",
];

const SEARCH_MAX_MS = 31 * 24 * 60 * 60 * 1000;

/** The menu's metadata key / match / value filters as `metadata[key_op]`. */
const applyMetadataFilter = (params: URLSearchParams) => {
  const key = params.get(`filter[${METADATA_FILTER.key}]`);
  const op = params.get(`filter[${METADATA_FILTER.op}]`);
  const value = params.get(`filter[${METADATA_FILTER.value}]`);
  for (const dataKey of Object.values(METADATA_FILTER)) {
    params.delete(`filter[${dataKey}]`);
    params.delete(`filter[${dataKey}_op]`);
  }
  if (key && value) {
    const operator = op === "contains" ? "contains" : "equals";
    params.set(`metadata[${key}_${operator}]`, value);
  }
};

/**
 * Core refuses a search over more than 31 days, so a longer date range is
 * searched from 31 days before its end (the search filter's title says so).
 * Without an end, core's own default (its last 31 days) is used: a start
 * computed from the browser's clock is already too early by the time core
 * checks it, and would change the query string on every call.
 */
const clampSearchWindow = (params: URLSearchParams) => {
  const from = params.get("filter[createdAt_gte]");
  if (!params.get("filter[q]") || !from) return;
  const to = params.get("filter[createdAt_lte]");
  const end = to ? Date.parse(to) : Date.now();
  if (end - Date.parse(from) <= SEARCH_MAX_MS) return;
  if (to) {
    params.set(
      "filter[createdAt_gte]",
      new Date(end - SEARCH_MAX_MS).toISOString()
    );
  } else {
    params.delete("filter[createdAt_gte]");
    params.delete("filter[createdAt_gte_op]");
  }
};

/**
 * Turns an `InfiniteScroll` query string into what core's cursor list
 * endpoints accept. `offset` is left for `useInfiniteCursor`, which strips it
 * and uses a repeated query string as "fetch the next page".
 */
const toCoreQuery = (
  queryString: string,
  organizationFilter?: string | null
): string => {
  const params = new URLSearchParams(queryString);
  for (const field of EQUALS_ONLY_FIELDS) {
    params.delete(`filter[${field}_op]`);
  }
  applyMetadataFilter(params);
  clampSearchWindow(params);
  if (organizationFilter) {
    params.set("filter[organizationId]", organizationFilter);
  }
  return params.toString();
};

/**
 * `useInfiniteCursor` over one of core's audit list endpoints
 * (`{ data, hasMore, limit, nextCursor }`), with the query string adapted to
 * core's filter operators. `organizationFilter` is for pages whose menu has no
 * organization filter of its own.
 */
const useCursorInfinite = (
  queryKey: string,
  endpoint: string,
  enabled = true,
  organizationFilter?: string | null
): UseInfiniteReturn<AuditLogEntry> => {
  const { hasPermission, currentOrganization } = useAuth();
  const axios = useAxios("audit");

  const result = useInfiniteCursor<AuditLogEntry>({
    axiosInstance: axios,
    endpoint,
    queryKey,
    orgId: currentOrganization?.id ?? null,
    initialLimit: 25,
    enabled: enabled && hasPermission("audit-logs.read"),
  });

  const { onQueryChange: baseOnQueryChange } = result;
  const onQueryChange = useCallback(
    (queryString: string) =>
      baseOnQueryChange(toCoreQuery(queryString, organizationFilter)),
    [baseOnQueryChange, organizationFilter]
  );

  return { ...result, onQueryChange };
};

export default useCursorInfinite;
