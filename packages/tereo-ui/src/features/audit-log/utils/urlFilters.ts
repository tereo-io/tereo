import { AUDIT_ACTIONS, SYSTEM_WIDE, type AuditLogFacets } from "../types";
import type {
  InfiniteScrollMenu,
  InfiniteScrollMenuFilter,
} from "@kosmeo-ui/react";

/**
 * The audit log page keeps its filters in the URL with readable keys, so a
 * view can be linked:
 *
 *   /audit-log/entries?action=UPDATE,DELETE&entityType=bucket&from=2026-10-01T00:00:00Z
 *   /audit-log/entries?q=invoice&metaKey=requestId&metaOp=contains&metaValue=abc
 *
 * `organizationId` (an org id or `none`) is audit-logs.admin only; without it
 * core scopes to the token's organization.
 *
 * Each key maps to one of core's `listQuerySchema` filters, except the
 * metadata trio (`metaKey`, `metaOp`, `metaValue`), which `toCoreQuery` turns
 * into one `metadata[key_op]=value`. `InfiniteScroll` speaks `filter[field]` /
 * `filter[field_op]`; these helpers convert both ways.
 */

/** Multi-select dropdowns fed by the facets endpoint, sent with `_op=in`. */
const FACET_KEYS = ["source", "entityType"] as const;
/**
 * Filters edited as a single value. `q`, `entityName` and `userEmail` match
 * substrings; the rest are `equals` (see `toCoreQuery`).
 */
const SEARCH_KEYS = [
  "q",
  "entityName",
  "entityId",
  "userId",
  "userEmail",
  "writerUserId",
  "correlationId",
  "ipAddress",
] as const;

const SEARCH_TITLES: Record<(typeof SEARCH_KEYS)[number], string> = {
  q: "Search (latest 31 days)",
  entityName: "Entity Name",
  entityId: "Entity ID",
  userId: "User ID",
  userEmail: "User Email",
  writerUserId: "Writer ID",
  correlationId: "Correlation ID",
  ipAddress: "IP Address",
};

/** `InfiniteScroll` data keys of the metadata filter (URL: `metaKey` etc.). */
export const METADATA_FILTER = {
  key: "metadataKey",
  op: "metadataOp",
  value: "metadataValue",
} as const;

/** Query params that are filters (the rest — `entry` — are UI state). */
const FILTER_PARAM_KEYS = [
  "organizationId",
  "action",
  ...FACET_KEYS,
  ...SEARCH_KEYS,
  "metaKey",
  "metaOp",
  "metaValue",
  "from",
  "to",
  "dir",
];

const titleCase = (value: string) =>
  value.charAt(0) + value.slice(1).toLowerCase();

const splitList = (value: string | null) =>
  new Set((value ?? "").split(",").filter(Boolean));

/**
 * Dropdown options: every facet value, plus any value the URL names that the
 * facets lack (a link to a source with no entries left), so it shows selected.
 */
const facetOptions = (values: string[], selected: Set<string>) =>
  [...new Set([...values, ...selected])].sort().map((value) => ({
    id: value,
    name: value,
    selected: selected.has(value),
  }));

export interface AuditLogMenuOptions {
  facets?: AuditLogFacets;
  /** Organizations offered in the organization filter; omit to hide it. */
  organizations?: { id: string; name: string }[];
}

const organizationFilter = (
  organizations: { id: string; name: string }[],
  selectedId: string | null
): InfiniteScrollMenuFilter => {
  const options = [{ id: SYSTEM_WIDE, name: "System-wide" }, ...organizations];
  if (selectedId && !options.some((o) => o.id === selectedId)) {
    options.push({ id: selectedId, name: selectedId });
  }
  return {
    type: "SELECT",
    title: "Organization",
    dataKey: "organizationId",
    options: options.map((o) => ({ ...o, selected: o.id === selectedId })),
  };
};

/**
 * One metadata condition: a key from the facets, `equals` or `contains`, and
 * the value. Applied only when both a key and a value are set.
 */
const metadataFilters = (
  params: URLSearchParams,
  keys: string[]
): InfiniteScrollMenuFilter[] => {
  const op = params.get("metaOp") === "contains" ? "contains" : "equals";
  return [
    {
      type: "SELECT",
      title: "Metadata Key",
      dataKey: METADATA_FILTER.key,
      options: facetOptions(keys, splitList(params.get("metaKey"))),
    },
    {
      type: "SELECT",
      title: "Metadata Match",
      dataKey: METADATA_FILTER.op,
      options: [
        { id: "equals", name: "Equals", selected: op === "equals" },
        { id: "contains", name: "Contains", selected: op === "contains" },
      ],
    },
    {
      type: "SEARCH",
      title: "Metadata Value",
      dataKey: METADATA_FILTER.value,
      value: params.get("metaValue") ?? undefined,
    },
  ];
};

/** Build the `InfiniteScroll` menu with its initial state taken from the URL. */
export const menuFromSearchParams = (
  params: URLSearchParams,
  { facets, organizations }: AuditLogMenuOptions = {}
): InfiniteScrollMenu => {
  const actions = splitList(params.get("action"));
  const dir = params.get("dir") === "asc" ? "asc" : "desc";

  return {
    title: "Audit Log",
    titleAs: "h1",
    limitOptions: [
      { value: 25, selected: false },
      { value: 50, selected: true },
      { value: 100, selected: false },
      { value: 200, selected: false },
    ],
    filters: [
      ...(organizations
        ? [organizationFilter(organizations, params.get("organizationId"))]
        : []),
      {
        type: "SELECT",
        title: "Action",
        dataKey: "action",
        multiSelect: true,
        options: AUDIT_ACTIONS.map((action) => ({
          id: action,
          name: titleCase(action),
          selected: actions.has(action),
        })),
      },
      {
        type: "SELECT",
        title: "Source",
        dataKey: "source",
        multiSelect: true,
        options: facetOptions(
          facets?.sources ?? [],
          splitList(params.get("source"))
        ),
      },
      {
        type: "SELECT",
        title: "Entity Type",
        dataKey: "entityType",
        multiSelect: true,
        options: facetOptions(
          facets?.entityTypes ?? [],
          splitList(params.get("entityType"))
        ),
      },
      ...SEARCH_KEYS.map((key) => ({
        type: "SEARCH" as const,
        title: SEARCH_TITLES[key],
        dataKey: key,
        value: params.get(key) ?? undefined,
      })),
      ...metadataFilters(params, facets?.metadataKeys ?? []),
      {
        type: "RANGE",
        title: "Date",
        dataKey: "createdAt",
        rangeType: "DATETIME",
        startValue: params.get("from") ?? undefined,
        endValue: params.get("to") ?? undefined,
      },
    ],
    sort: {
      sortDataKeys: [
        { dataKey: "createdAt", displayName: "Timestamp", selected: true },
      ],
      sortDirection: dir,
    },
  };
};

/**
 * Read the filters out of an `InfiniteScroll` query string into the page's
 * URL keys, keeping any non-filter params (e.g. `entry`) from `current`.
 */
export const searchParamsFromQuery = (
  queryString: string,
  current: URLSearchParams
): URLSearchParams => {
  const query = new URLSearchParams(queryString);
  const next = new URLSearchParams(current);
  for (const key of FILTER_PARAM_KEYS) next.delete(key);

  const set = (key: string, value: string | null) => {
    if (value) next.set(key, value);
  };
  set("organizationId", query.get("filter[organizationId]"));
  set("action", query.get("filter[action]"));
  for (const key of [...FACET_KEYS, ...SEARCH_KEYS]) {
    set(key, query.get(`filter[${key}]`));
  }
  const metaKey = query.get(`filter[${METADATA_FILTER.key}]`);
  const metaValue = query.get(`filter[${METADATA_FILTER.value}]`);
  if (metaKey && metaValue) {
    next.set("metaKey", metaKey);
    if (query.get(`filter[${METADATA_FILTER.op}]`) === "contains") {
      next.set("metaOp", "contains");
    }
    next.set("metaValue", metaValue);
  }
  set("from", query.get("filter[createdAt_gte]"));
  set("to", query.get("filter[createdAt_lte]"));
  if (query.get("sortDir") === "asc") next.set("dir", "asc");
  return next;
};

/** The filter part of a URL search string, for comparing two URLs. */
export const filterKey = (params: URLSearchParams): string => {
  const out = new URLSearchParams();
  for (const key of FILTER_PARAM_KEYS) {
    const value = params.get(key);
    if (value) out.set(key, value);
  }
  return out.toString();
};

/** Link to the audit log filtered to the given values. */
export const auditLogHref = (filters: Record<string, string>): string => {
  const params = new URLSearchParams(filters);
  const qs = params.toString();
  return qs ? `/audit-log/entries?${qs}` : "/audit-log/entries";
};

/**
 * Link to one entity's full history page; `organizationId` (an org id or
 * `none`) carries an admin's organization filter along.
 */
export const entityHistoryHref = (
  entityType: string,
  entityId: string,
  organizationId?: string | null
) => {
  const path = `/audit-log/entity/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`;
  return organizationId
    ? `${path}?${new URLSearchParams({ organizationId })}`
    : path;
};
