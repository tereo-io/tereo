import useAllOrganizations from "../../api/organizations/useAllOrganizations";
import ArchiveRestoreGroupButton from "./buttons/ArchiveRestoreGroupButton";
import useInfiniteGroups from "../../api/groups/useInfiniteGroups";
import { ProvisionedBadge } from "@/components/ProvisionedBadge";
import CreateGroupModal from "./modals/CreateGroupModal";
import { Link, useNavigate } from "react-router-dom";
import type { Group } from "../../api/groups/types";
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

interface GroupListProps {
  /** Lists one organization's groups, without the organization column. */
  organizationId?: string;
  /** Whether the viewer may create groups here. Defaults to `groups.write`. */
  canCreate?: boolean;
}

export const GroupList = ({ organizationId, canCreate }: GroupListProps) => {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { data, hasMore, isLoading, onQueryChange, reload } = useInfiniteGroups(
    { organizationId }
  );
  const [showCreate, setShowCreate] = useState(false);
  // Each row carries only an organization id; names come from the list.
  const { data: organizations } = useAllOrganizations({
    enabled: !organizationId && hasPermission("organizations.read"),
  });

  const orgName = (id: string) =>
    organizations?.find((o) => o.id === id)?.name ?? id;

  const columns: TableColumn<Group>[] = useMemo(
    () => [
      {
        title: "Name",
        dataKey: "name",
        cellElement: (group) => (
          <span className="t-group-name">
            <TableCellLink as={Link} to={`/auth-admin/groups/${group.id}`}>
              {group.name}
            </TableCellLink>
            {group.definitionSource === "provisioned" && <ProvisionedBadge />}
            {group.managedBy && (
              <Badge size="sm" subtle variant="primary">
                Directory
              </Badge>
            )}
            {group.archivedAt !== null && (
              <Badge size="sm" variant="warning">
                Archived
              </Badge>
            )}
          </span>
        ),
      },
      { title: "Slug", dataKey: "slug" },
      ...(organizationId
        ? []
        : [
            {
              title: "Scope",
              dataKey: "organizationId",
              cellElement: (group: Group) =>
                group.organizationId ? (
                  <Link
                    to={`/auth-admin/organizations/${group.organizationId}`}
                    className="v-link"
                  >
                    {orgName(group.organizationId)}
                  </Link>
                ) : (
                  "Global"
                ),
            },
          ]),
      {
        title: "Members",
        dataKey: "memberCount",
        width: "7rem",
        align: "center",
      },
      {
        title: "Actions",
        disableRowClick: true,
        width: "7rem",
        align: "center",
        cellElement: (group) => <ArchiveRestoreGroupButton group={group} />,
      },
    ],
    [organizationId, organizations]
  );

  const menu: InfiniteScrollMenu = useMemo(
    () => ({
      title: "Groups",
      titleAs: organizationId ? "h2" : "h1",
      filters: [
        { type: "SEARCH", title: "Name or slug", dataKey: "q" },
        {
          type: "SELECT",
          title: "Source",
          dataKey: "definitionSource",
          options: [
            { id: "local", name: "Local", selected: false },
            { id: "provisioned", name: "Provisioned", selected: false },
          ],
        },
        {
          type: "SELECT",
          title: "Archived",
          dataKey: "includeArchived",
          options: [{ id: "true", name: "Include archived", selected: false }],
        },
      ],
    }),
    [organizationId]
  );

  const mayCreate = canCreate ?? hasPermission("groups.write");

  return (
    <Page fillHeight maxWidth="none" padded={false}>
      <InfiniteScroll<Group>
        menu={menu}
        data={data}
        hasMore={hasMore}
        isLoading={isLoading}
        onQueryChange={onQueryChange}
        columns={columns}
        onReload={reload}
        onAddNew={mayCreate ? () => setShowCreate(true) : undefined}
        onRowClick={(group) => navigate(`/auth-admin/groups/${group.id}`)}
        hideSelectColumn
      />
      <CreateGroupModal
        show={showCreate}
        organizationId={organizationId}
        onCreate={() => {
          setShowCreate(false);
          reload();
        }}
        onClose={() => setShowCreate(false)}
      />
    </Page>
  );
};
