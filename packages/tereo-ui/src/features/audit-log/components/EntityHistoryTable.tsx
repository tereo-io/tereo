import { InfiniteScroll, type InfiniteScrollMenu } from "@kosmeo-ui/react";
import type { UseInfiniteReturn } from "@kosmeo-ui/react";
import AuditLogDetailModal from "./AuditLogDetailModal";
import { entityHistoryColumns } from "./columns";
import type { AuditLogEntry } from "../types";
import { useMemo, useState } from "react";

interface EntityHistoryTableProps {
  history: UseInfiniteReturn<AuditLogEntry>;
  title?: string;
  /** Hide the header (sort, limit, refresh). */
  compact?: boolean;
  /** The history's organization filter (an org id or `none`). */
  organizationFilter?: string | null;
}

/**
 * One entity's history as an infinite table, newest first, with the entry
 * detail modal on row click. Fed by `useInfiniteEntityHistory`.
 */
const EntityHistoryTable = ({
  history,
  title = "History",
  compact = false,
  organizationFilter,
}: EntityHistoryTableProps) => {
  const { data, hasMore, isLoading, onQueryChange, reload } = history;
  const [selected, setSelected] = useState<AuditLogEntry | null>(null);

  const menu: InfiniteScrollMenu = useMemo(
    () => ({
      title,
      filters: [
        { type: "SEARCH", title: "User Email", dataKey: "userEmail" },
        { type: "SEARCH", title: "Writer ID", dataKey: "writerUserId" },
      ],
      sort: {
        sortDataKeys: [
          { dataKey: "createdAt", displayName: "Timestamp", selected: true },
        ],
        sortDirection: "desc",
      },
    }),
    [title]
  );

  return (
    <>
      <InfiniteScroll<AuditLogEntry>
        menu={menu}
        data={data}
        hasMore={hasMore}
        isLoading={isLoading}
        onQueryChange={onQueryChange}
        onReload={reload}
        columns={entityHistoryColumns}
        onRowClick={setSelected}
        emptyMessage="No audit log entries for this entity"
        hideSelectColumn
        hideFilters={compact}
      />
      <AuditLogDetailModal
        entryId={selected?.id ?? null}
        entry={selected}
        onClose={() => setSelected(null)}
        showHistoryLink={false}
        organizationFilter={organizationFilter}
      />
    </>
  );
};

export default EntityHistoryTable;
