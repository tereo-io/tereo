import useInfinitePermissions from "../../api/permissions/useInfinitePermissions";
import type { Permission } from "../../api/permissions/types";
import { useServices } from "@/features/services";
import { useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import PermissionDetailModal, {
  OrgAssignableBadge,
  PermissionStatusBadge,
} from "./modals/PermissionDetailModal";
import {
  InfiniteScroll,
  Page,
  type TableColumn,
  type InfiniteScrollMenu,
} from "@kosmeo-ui/react";

// Read-only: permissions are declared in code by the service that owns them
// and applied from their provisioning documents. Admins compose custom roles from them.
export const PermissionList = () => {
  const { hasPermission } = useAuth();
  const { data, hasMore, isLoading, onQueryChange, reload } =
    useInfinitePermissions();
  const { data: services } = useServices();
  const [permission, setPermission] = useState<Permission | null>(null);

  const columns: TableColumn<Permission>[] = useMemo(
    () => [
      {
        title: "Name",
        dataKey: "name",
        cellElement: (p) => <span className="v-mono">{p.name}</span>,
      },
      { title: "Display Name", dataKey: "displayName" },
      {
        title: "Service",
        dataKey: "serviceId",
        cellElement: (p) => p.serviceName,
      },
      {
        title: "Org-assignable",
        dataKey: "orgAssignable",
        width: "9rem",
        align: "center",
        cellElement: (p) => <OrgAssignableBadge permission={p} />,
      },
      {
        title: "Status",
        dataKey: "retiredAt",
        width: "7rem",
        align: "center",
        cellElement: (p) => <PermissionStatusBadge permission={p} />,
      },
    ],
    []
  );

  const menu: InfiniteScrollMenu = useMemo(
    () => ({
      title: "Permissions",
      filters: [
        {
          type: "SEARCH",
          title: "Name",
          dataKey: "name",
        },
        {
          type: "SEARCH",
          title: "Display Name",
          dataKey: "displayName",
        },
        ...(services && services.length > 0
          ? [
              {
                type: "SELECT" as const,
                title: "Service",
                dataKey: "serviceId",
                options: services.map((s) => ({
                  id: s.id,
                  name: s.name,
                  selected: false,
                })),
              },
            ]
          : []),
        {
          type: "SELECT",
          title: "Org-assignable",
          dataKey: "orgAssignable",
          options: [
            { id: "true", name: "Org-assignable", selected: false },
            { id: "false", name: "Global only", selected: false },
          ],
        },
        {
          type: "SELECT",
          title: "Retired",
          dataKey: "includeRetired",
          options: [{ id: "true", name: "Include retired", selected: false }],
        },
      ],
      sort: {
        sortDataKeys: [
          { dataKey: "id", displayName: "ID", selected: false },
          { dataKey: "name", displayName: "Name", selected: true },
          {
            dataKey: "displayName",
            displayName: "Display Name",
            selected: false,
          },
          { dataKey: "createdAt", displayName: "Registered", selected: false },
        ],
        sortDirection: "asc",
      },
    }),
    [services]
  );

  if (!hasPermission("permissions.read")) return null;

  return (
    <Page fillHeight maxWidth="none">
      <InfiniteScroll<Permission>
        menu={menu}
        data={data}
        hasMore={hasMore}
        isLoading={isLoading}
        onQueryChange={onQueryChange}
        columns={columns}
        onReload={reload}
        onRowClick={setPermission}
        hideSelectColumn
      />
      <PermissionDetailModal
        permission={permission}
        show={permission !== null}
        onClose={() => setPermission(null)}
      />
    </Page>
  );
};
