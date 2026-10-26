import ArchiveRestoreOrganizationListButton from "./buttons/ArchiveRestoreOrganizationListButton";
import useInfiniteOrganizations from "../../api/organizations/useInfiniteOrganizations";
import CreateOrganizationModal from "./modals/CreateOrganizationModal";
import type { Organization } from "../../api/organizations/types";
import { Link, useNavigate } from "react-router-dom";
import { formatDate } from "@/utils/formatDate";
import { useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import {
  Badge,
  InfiniteScroll,
  Page,
  Row,
  TableCellLink,
  type TableColumn,
  type InfiniteScrollMenu,
} from "@kosmeo-ui/react";

export const OrganizationList = () => {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { data, hasMore, isLoading, onQueryChange, reload } =
    useInfiniteOrganizations();
  const [showCreateModal, setShowCreateModal] = useState(false);

  const columns: TableColumn<Organization>[] = useMemo(
    () => [
      {
        title: "Name",
        dataKey: "name",
        cellElement: (org) => (
          <Row size="sm" align="center" wrap>
            <TableCellLink as={Link} to={`/auth-admin/organizations/${org.id}`}>
              {org.name}
            </TableCellLink>
            {org.archivedAt !== null && (
              <Badge size="sm" variant="warning">
                Archived
              </Badge>
            )}
          </Row>
        ),
      },
      { title: "Slug", dataKey: "slug" },
      {
        title: "Members",
        dataKey: "memberCount",
        width: "7rem",
        align: "center",
      },
      {
        title: "Status",
        dataKey: "isActive",
        width: "7rem",
        align: "center",
        cellElement: (org) => (
          <Badge
            size="sm"
            subtle={true}
            variant={org.isActive ? "success" : "danger"}
          >
            {org.isActive ? "Active" : "Inactive"}
          </Badge>
        ),
      },
      {
        title: "Created",
        dataKey: "createdAt",
        cellElement: (org) => formatDate(org.createdAt),
      },
      {
        title: "Actions",
        disableRowClick: true,
        width: "7rem",
        align: "center",
        cellElement: (org) => (
          <ArchiveRestoreOrganizationListButton organization={org} />
        ),
      },
    ],
    [navigate]
  );

  const menu: InfiniteScrollMenu = useMemo(
    () => ({
      title: "Organizations",
      filters: [
        {
          type: "SEARCH",
          title: "Name",
          dataKey: "name",
        },
        {
          type: "SEARCH",
          title: "Slug",
          dataKey: "slug",
        },
        {
          type: "SEARCH",
          title: "Code",
          dataKey: "code",
        },
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
      ],
      sort: {
        sortDataKeys: [
          { dataKey: "id", displayName: "ID", selected: false },
          { dataKey: "name", displayName: "Name", selected: true },
          { dataKey: "slug", displayName: "Slug", selected: false },
          { dataKey: "createdAt", displayName: "Created", selected: false },
        ],
        sortDirection: "asc",
      },
    }),
    []
  );

  if (!hasPermission("organizations.read")) return null;

  return (
    <Page fillHeight maxWidth="none">
      <InfiniteScroll<Organization>
        menu={menu}
        data={data}
        hasMore={hasMore}
        isLoading={isLoading}
        onQueryChange={onQueryChange}
        columns={columns}
        onReload={reload}
        onAddNew={
          hasPermission("organizations.write")
            ? () => setShowCreateModal(true)
            : undefined
        }
        onRowClick={(org) => navigate(`/auth-admin/organizations/${org.id}`)}
        hideSelectColumn
      />
      <CreateOrganizationModal
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
