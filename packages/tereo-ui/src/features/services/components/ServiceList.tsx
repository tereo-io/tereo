import useInfiniteServices from "../api/useInfiniteServices";
import CreateServiceModal from "./modals/CreateServiceModal";
import { ServiceStatusBadge } from "./StatusBadges";
import type { ServiceListItem } from "../api/types";
import { useNavigate } from "react-router-dom";
import { CORE_SERVICE_ID } from "../constants";
import { useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import {
  Badge,
  InfiniteScroll,
  Page,
  type InfiniteScrollMenu,
  type TableColumn,
} from "@kosmeo-ui/react";

export const ServiceList = () => {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { data, hasMore, isLoading, onQueryChange, reload } =
    useInfiniteServices();
  const [showCreateModal, setShowCreateModal] = useState(false);

  const columns: TableColumn<ServiceListItem>[] = useMemo(
    () => [
      {
        title: "Name",
        dataKey: "name",
        cellElement: (s) =>
          s.id === CORE_SERVICE_ID ? (
            <span>
              {s.name}{" "}
              <Badge size="sm" subtle variant="secondary">
                core
              </Badge>
            </span>
          ) : (
            s.name
          ),
      },
      {
        title: "Slug",
        dataKey: "slug",
        cellElement: (s) => <span className="v-mono">{s.slug}</span>,
      },
      {
        title: "Namespace",
        dataKey: "namespace",
        cellElement: (s) => <span className="v-mono">{s.namespace}</span>,
      },
      {
        title: "Last Registered",
        dataKey: "declaredAt",
        cellElement: (s) =>
          s.declaredAt ? (
            new Date(s.declaredAt).toLocaleString()
          ) : (
            <span className="v-muted-text">Never</span>
          ),
      },
      {
        title: "Pending Access",
        dataKey: "pendingAccessCount",
        width: "9rem",
        align: "center",
        cellElement: (s) =>
          s.pendingAccessCount > 0 ? (
            <Badge size="sm" variant="warning">
              {s.pendingAccessCount} pending
            </Badge>
          ) : (
            <span className="v-muted-text">—</span>
          ),
      },
      {
        title: "Status",
        dataKey: "isActive",
        width: "7rem",
        align: "center",
        cellElement: (s) => <ServiceStatusBadge isActive={s.isActive} />,
      },
    ],
    []
  );

  const menu: InfiniteScrollMenu = useMemo(
    () => ({
      title: "Services",
      filters: [
        { type: "SEARCH", title: "Name", dataKey: "name" },
        { type: "SEARCH", title: "Slug", dataKey: "slug" },
      ],
      sort: {
        sortDataKeys: [
          { dataKey: "name", displayName: "Name", selected: true },
          { dataKey: "slug", displayName: "Slug", selected: false },
          { dataKey: "createdAt", displayName: "Created", selected: false },
        ],
        sortDirection: "asc",
      },
    }),
    []
  );

  return (
    <Page fillHeight maxWidth="none">
      <InfiniteScroll<ServiceListItem>
        menu={menu}
        data={data}
        hasMore={hasMore}
        isLoading={isLoading}
        onQueryChange={onQueryChange}
        columns={columns}
        onReload={reload}
        onAddNew={
          hasPermission("services.write")
            ? () => setShowCreateModal(true)
            : undefined
        }
        onRowClick={(s) => navigate(`/services/${s.id}`)}
        hideSelectColumn
      />
      <CreateServiceModal
        show={showCreateModal}
        onClose={() => setShowCreateModal(false)}
      />
    </Page>
  );
};
