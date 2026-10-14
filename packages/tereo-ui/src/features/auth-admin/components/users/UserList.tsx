import useInfiniteUsers from "../../api/users/useInfiniteUsers";
import CreateUserModal from "./modals/CreateUserModal";
import { useNavigate } from "react-router-dom";
import { User } from "../../api/users/types";
import { useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import {
  Badge,
  InfiniteScroll,
  Page,
  type TableColumn,
  type InfiniteScrollMenu,
} from "@kosmeo-ui/react";

export const UserList = () => {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { data, hasMore, isLoading, onQueryChange, reload } =
    useInfiniteUsers();
  const [showCreateModal, setShowCreateModal] = useState(false);

  const columns: TableColumn<User>[] = useMemo(
    () => [
      { title: "Email", dataKey: "email" },
      {
        title: "Name",
        dataKey: "name",
        cellElement: (user) => user.name || "-",
      },
      {
        title: "User Type",
        dataKey: "userType",
        width: "9rem",
        align: "center",
        cellElement: (user) => (
          <Badge
            size="sm"
            subtle={true}
            variant={user.userType === "human" ? "primary" : "secondary"}
          >
            {user.userType === "human" ? "Human" : "Service Account"}
          </Badge>
        ),
      },
      {
        title: "Created",
        dataKey: "createdAt",
        cellElement: (user) => new Date(user.createdAt).toLocaleDateString(),
      },
      {
        title: "Status",
        dataKey: "isActive",
        width: "7rem",
        align: "center",
        cellElement: (user) => (
          <Badge
            size="sm"
            subtle={true}
            variant={user.isActive ? "success" : "danger"}
          >
            {user.isActive ? "Active" : "Inactive"}
          </Badge>
        ),
      },
    ],
    []
  );

  const menu: InfiniteScrollMenu = useMemo(
    () => ({
      title: "Users",
      filters: [
        {
          type: "SEARCH",
          title: "Email",
          dataKey: "email",
        },
        {
          type: "SEARCH",
          title: "Name",
          dataKey: "name",
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
      ],
      sort: {
        sortDataKeys: [
          { dataKey: "id", displayName: "ID", selected: false },
          { dataKey: "email", displayName: "Email", selected: true },
          { dataKey: "name", displayName: "Name", selected: false },
          { dataKey: "createdAt", displayName: "Created", selected: false },
        ],
        sortDirection: "asc",
      },
    }),
    []
  );

  if (!hasPermission("users.read")) return null;

  return (
    <Page fillHeight maxWidth="none">
      <InfiniteScroll<User>
        menu={menu}
        data={data}
        hasMore={hasMore}
        isLoading={isLoading}
        onQueryChange={onQueryChange}
        columns={columns}
        onReload={reload}
        onAddNew={
          hasPermission("users.write")
            ? () => setShowCreateModal(true)
            : undefined
        }
        onRowClick={(u) => navigate(`/auth-admin/users/${u.id}`)}
        hideSelectColumn
      />
      <CreateUserModal
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
