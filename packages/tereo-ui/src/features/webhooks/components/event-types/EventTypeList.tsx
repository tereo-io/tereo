import useInfiniteEventTypes from "../../api/event-types/useInfiniteEventTypes";
import { formatDate, formatDateTime } from "@/utils/formatDate";
import type { EventTypeRow } from "../../api/types";
import { useAuth } from "@/lib/auth";
import { useMemo } from "react";
import "../styles.css";
import {
  Badge,
  InfiniteScroll,
  Page,
  type InfiniteScrollMenu,
  type TableColumn,
} from "@kosmeo-ui/react";

/**
 * Read-only: event types are declared in their services' provisioning documents and retire a
 * day after a service stops declaring them (docs/registry.md).
 */
export const EventTypeList = () => {
  const { hasPermission } = useAuth();
  const { data, hasMore, isLoading, onQueryChange, reload } =
    useInfiniteEventTypes();

  const columns: TableColumn<EventTypeRow>[] = useMemo(
    () => [
      {
        title: "Event Type",
        dataKey: "eventType",
        cellElement: (et) => <span className="v-mono">{et.eventType}</span>,
      },
      {
        title: "Description",
        dataKey: "description",
        cellElement: (et) =>
          et.description || <span className="v-muted-text">—</span>,
      },
      {
        title: "Service",
        dataKey: "serviceName",
        width: "14rem",
        cellElement: (et) => (
          <span title={`Namespace: ${et.source}`}>{et.serviceName}</span>
        ),
      },
      {
        title: "State",
        dataKey: "retiredAt",
        width: "10rem",
        cellElement: (et) =>
          et.retiredAt ? (
            <Badge
              size="sm"
              variant="danger"
              subtle
              ariaLabel={`Retired ${formatDateTime(et.retiredAt)}`}
            >
              Retired
            </Badge>
          ) : et.missingSince ? (
            <Badge size="sm" variant="warning" subtle>
              Retiring
            </Badge>
          ) : (
            <Badge size="sm" variant="success" subtle>
              Active
            </Badge>
          ),
      },
      {
        title: "Registered",
        dataKey: "createdAt",
        width: "9rem",
        cellElement: (et) => formatDate(et.createdAt),
      },
    ],
    []
  );

  const menu: InfiniteScrollMenu = useMemo(
    () => ({
      title: "Event Types",
      titleAs: "h1",
      filters: [
        { type: "SEARCH", title: "Event Type", dataKey: "eventType" },
        {
          type: "SELECT",
          title: "Retired",
          dataKey: "retired",
          options: [
            { id: "false", name: "Not retired", selected: false },
            { id: "true", name: "Retired", selected: false },
          ],
        },
      ],
      sort: {
        sortDataKeys: [
          { dataKey: "eventType", displayName: "Event Type", selected: true },
          { dataKey: "createdAt", displayName: "Registered", selected: false },
        ],
        sortDirection: "asc",
      },
    }),
    []
  );

  if (!hasPermission("webhooks.event-types.read")) return null;

  return (
    <Page fillHeight maxWidth="none">
      <InfiniteScroll<EventTypeRow>
        menu={menu}
        data={data}
        hasMore={hasMore}
        isLoading={isLoading}
        onQueryChange={onQueryChange}
        columns={columns}
        onReload={reload}
        hideSelectColumn
      />
    </Page>
  );
};
