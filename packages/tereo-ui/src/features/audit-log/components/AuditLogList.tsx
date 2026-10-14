import useInfiniteAuditLogEntries from "../api/useInfiniteAuditLogEntries";
import { adminAuditLogColumns, auditLogColumns } from "./columns";
import useAuditLogFacets from "../api/useAuditLogFacets";
import { InfiniteScroll, Page } from "@kosmeo-ui/react";
import AuditLogDetailModal from "./AuditLogDetailModal";
import { useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import type { AuditLogEntry } from "../types";
import { useAuth } from "@/lib/auth";
import {
  filterKey,
  menuFromSearchParams,
  searchParamsFromQuery,
} from "../utils/urlFilters";

/**
 * `/audit-log/entries` — every entry in the caller's organization, newest
 * first; audit-logs.admin can switch to another organization or to
 * system-wide entries.
 *
 * Filters live in the URL (see `utils/urlFilters.ts`) so a view can be linked;
 * `?entry=<id>` opens that entry's detail.
 */
export const AuditLogList = () => {
  const { hasPermission, organizations } = useAuth();
  const isAdmin = hasPermission("audit-logs.admin");
  const [searchParams, setSearchParams] = useSearchParams();
  const entries = useInfiniteAuditLogEntries();
  const { data, hasMore, isLoading, onQueryChange, reload } = entries;
  const organizationFilter = isAdmin
    ? searchParams.get("organizationId")
    : null;
  const { data: facets } = useAuditLogFacets(organizationFilter);

  // The menu seeds InfiniteScroll's filter state; rebuilding it resets that
  // state. Rebuild only when the URL's filters change from outside (a link,
  // back/forward) or new dropdown options arrive — not when this page wrote
  // them after the user applied.
  const urlFilters = filterKey(searchParams);
  const writtenFiltersRef = useRef<string | null>(null);
  const menuSourceRef = useRef<string | null>(null);
  const menuFacetsRef = useRef(facets);
  if (
    menuSourceRef.current === null ||
    urlFilters !== writtenFiltersRef.current ||
    menuFacetsRef.current !== facets
  ) {
    menuSourceRef.current = urlFilters;
    menuFacetsRef.current = facets;
  }
  const menuSource = menuSourceRef.current;
  const menuFacets = menuFacetsRef.current;
  const organizationOptions = useMemo(
    () =>
      isAdmin ? organizations.map(({ id, name }) => ({ id, name })) : undefined,
    [isAdmin, organizations]
  );
  const menu = useMemo(
    () =>
      menuFromSearchParams(new URLSearchParams(menuSource), {
        facets: menuFacets,
        organizations: organizationOptions,
      }),
    [menuSource, menuFacets, organizationOptions]
  );

  // InfiniteScroll reports its query once with empty filters before the
  // menu's filters land; don't let that wipe the URL.
  const skipNextWriteRef = useRef(true);
  const lastMenuRef = useRef(menu);
  if (lastMenuRef.current !== menu) {
    lastMenuRef.current = menu;
    skipNextWriteRef.current = true;
  }

  // Kept in refs so `handleQueryChange` stays stable: InfiniteScroll re-sends
  // its query whenever that callback changes, and the hook reads a repeated
  // query as "fetch the next page".
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const setSearchParamsRef = useRef(setSearchParams);
  setSearchParamsRef.current = setSearchParams;

  const handleQueryChange = useCallback(
    (queryString: string) => {
      onQueryChange(queryString);
      if (skipNextWriteRef.current) {
        skipNextWriteRef.current = false;
        return;
      }
      const current = searchParamsRef.current;
      const next = searchParamsFromQuery(queryString, current);
      const nextFilters = filterKey(next);
      writtenFiltersRef.current = nextFilters;
      if (nextFilters !== filterKey(current)) {
        setSearchParamsRef.current(next, { replace: true });
      }
    },
    [onQueryChange]
  );

  const selectedId = searchParams.get("entry");
  const selectedEntry = useMemo(
    () => data.find((e) => e.id === selectedId) ?? null,
    [data, selectedId]
  );

  const openEntry = (entry: AuditLogEntry) => {
    const next = new URLSearchParams(searchParams);
    next.set("entry", entry.id);
    setSearchParams(next);
  };

  const closeEntry = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("entry");
    setSearchParams(next, { replace: true });
  };

  if (!hasPermission("audit-logs.read")) return null;
  return (
    <Page fillHeight maxWidth="none">
      <InfiniteScroll<AuditLogEntry>
        menu={menu}
        data={data}
        hasMore={hasMore}
        isLoading={isLoading}
        onQueryChange={handleQueryChange}
        onReload={reload}
        columns={isAdmin ? adminAuditLogColumns : auditLogColumns}
        onRowClick={openEntry}
        emptyMessage="No audit log entries match these filters"
        hideSelectColumn
      />
      <AuditLogDetailModal
        entryId={selectedId}
        entry={selectedEntry}
        onClose={closeEntry}
        organizationFilter={organizationFilter}
      />
    </Page>
  );
};
