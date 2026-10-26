import ArchiveRestoreRoleListButton from "./buttons/ArchiveRestoreRoleListButton";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ProvisionedBadge } from "@/components/ProvisionedBadge";
import useInfiniteRoles from "../../api/roles/useInfiniteRoles";
import { faLock } from "@fortawesome/free-solid-svg-icons";
import CreateRoleModal from "./modals/CreateRoleModal";
import { Link, useNavigate } from "react-router-dom";
import { useServices } from "@/features/services";
import { Role } from "../../api/roles/types";
import { useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import "./styles.css";
import {
  Badge,
  InfiniteScroll,
  Page,
  TableCellLink,
  type TableColumn,
  type InfiniteScrollMenu,
} from "@kosmeo-ui/react";

export const RoleList = () => {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { data, hasMore, isLoading, onQueryChange, reload } =
    useInfiniteRoles();
  const [showCreateModal, setShowCreateModal] = useState(false);
  // Only for the Service filter's options: each row names its own service.
  const { data: services } = useServices();

  const columns: TableColumn<Role>[] = useMemo(
    () => [
      {
        title: "Name",
        dataKey: "name",
        cellElement: (role) => (
          <span className="t-role-name">
            <TableCellLink as={Link} to={`/auth-admin/roles/${role.id}`}>
              {role.name}
            </TableCellLink>
            {role.isSystem && (
              <FontAwesomeIcon
                icon={faLock}
                className="t-system-icon"
                title="System role"
              />
            )}
            {role.provisioned && <ProvisionedBadge />}
            {role.retiredAt !== null && (
              <Badge size="sm" variant="danger">
                Retired
              </Badge>
            )}
            {role.archivedAt !== null && (
              <Badge size="sm" variant="warning">
                Archived
              </Badge>
            )}
          </span>
        ),
      },
      { title: "Display Name", dataKey: "displayName" },
      {
        title: "Type",
        dataKey: "serviceId",
        cellElement: (role) =>
          role.serviceId ? (role.service?.name ?? "System") : "Custom",
      },
      {
        title: "Permissions",
        dataKey: "permissions",
        cellElement: (role) => role.permissions?.length || 0,
      },
      {
        title: "Status",
        dataKey: "isActive",
        width: "7rem",
        align: "center",
        cellElement: (role) => (
          <Badge
            size="sm"
            subtle={true}
            variant={role.isActive ? "success" : "danger"}
          >
            {role.isActive ? "Active" : "Inactive"}
          </Badge>
        ),
      },
      {
        title: "Actions",
        disableRowClick: true,
        width: "7rem",
        align: "center",
        cellElement: (role) =>
          role.provisioned ? null : (
            <ArchiveRestoreRoleListButton role={role} />
          ),
      },
    ],
    []
  );

  const menu: InfiniteScrollMenu = useMemo(
    () => ({
      title: "Roles",
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
                options: services.map((svc) => ({
                  id: svc.id,
                  name: svc.name,
                  selected: false,
                })),
              },
            ]
          : []),
        {
          type: "SELECT",
          title: "Status",
          dataKey: "isActive",
          options: [
            { id: "true", name: "Active", selected: false },
            { id: "false", name: "Inactive", selected: false },
          ],
        },
        {
          type: "SELECT",
          title: "Archived",
          dataKey: "includeArchived",
          options: [{ id: "true", name: "Include archived", selected: false }],
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
          { dataKey: "createdAt", displayName: "Created", selected: false },
        ],
        sortDirection: "asc",
      },
    }),
    [services]
  );

  if (!hasPermission("roles.read")) return null;

  return (
    <Page fillHeight maxWidth="none">
      <InfiniteScroll<Role>
        menu={menu}
        data={data}
        hasMore={hasMore}
        isLoading={isLoading}
        onQueryChange={onQueryChange}
        columns={columns}
        onReload={reload}
        onAddNew={
          hasPermission("roles.write")
            ? () => setShowCreateModal(true)
            : undefined
        }
        onRowClick={(role) => navigate(`/auth-admin/roles/${role.id}`)}
        hideSelectColumn
      />
      <CreateRoleModal
        show={showCreateModal}
        onCreate={() => {
          setShowCreateModal(false);
          reload();
        }}
        onClose={() => setShowCreateModal(false)}
      />
    </Page>
  );
};
