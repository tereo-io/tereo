import useInfiniteClients from "../../api/oauth-clients/useInfiniteClients";
import DeleteClientListButton from "./buttons/DeleteClientListButton";
import { faLock, faUnlock } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { OAuthClient } from "../../api/oauth-clients/types";
import CreateClientModal from "./modals/CreateClientModal";
import { useNavigate } from "react-router-dom";
import { useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import "./styles.css";
import {
  Badge,
  InfiniteScroll,
  Page,
  type TableColumn,
  type InfiniteScrollMenu,
} from "@kosmeo-ui/react";

export const ClientList = () => {
  const navigate = useNavigate();
  const { hasPermission, user } = useAuth();
  const { data, hasMore, isLoading, onQueryChange, reload } =
    useInfiniteClients();
  // Core deletes a client for its owner or a clients.admin holder, with
  // clients.delete.
  const mayDelete = hasPermission("clients.delete");
  const isClientsAdmin = hasPermission("clients.admin");
  const me = user?.sub;
  const [showCreateModal, setShowCreateModal] = useState(false);

  const columns: TableColumn<OAuthClient>[] = useMemo(
    () => [
      { title: "Client ID", dataKey: "clientId" },
      {
        title: "Name",
        dataKey: "name",
        cellElement: (client) => (
          <>
            {client.name}{" "}
            {client.service && (
              <Badge variant="primary">service: {client.service.name}</Badge>
            )}
          </>
        ),
      },
      {
        title: "Owner",
        dataKey: "ownerId",
        cellElement: (client) => {
          if (!client.owner) return <span className="v-muted-text">—</span>;
          return <span>{client.owner.name || client.owner.email}</span>;
        },
      },
      {
        title: "Grant Types",
        dataKey: "grantTypes",
        cellElement: (client) => client.grantTypes.length,
        width: "8rem",
      },
      {
        title: "Type",
        dataKey: "clientType",
        width: "10rem",
        cellElement: (client) => (
          <span className="t-client-type">
            <FontAwesomeIcon
              icon={client.clientType === "confidential" ? faLock : faUnlock}
            />
            <span>{client.clientType}</span>
          </span>
        ),
      },
      {
        title: "Service Acct",
        dataKey: "id",
        width: "8rem",
        align: "center",
        cellElement: (client) =>
          client.serviceAccountUser ? (
            <span className="v-muted-text">✓</span>
          ) : (
            <span className="v-muted-text">—</span>
          ),
      },
      {
        title: "Actions",
        disableRowClick: true,
        width: "7rem",
        align: "center",
        cellElement: (client) =>
          !client.service &&
          mayDelete &&
          (client.ownerId === me || isClientsAdmin) ? (
            <DeleteClientListButton client={client} />
          ) : null,
      },
    ],
    [navigate, mayDelete, isClientsAdmin, me]
  );

  const menu: InfiniteScrollMenu = useMemo(
    () => ({
      title: "OAuth Clients",
      filters: [
        {
          type: "SEARCH",
          title: "Name",
          dataKey: "name",
        },
        {
          type: "SEARCH",
          title: "Client ID",
          dataKey: "clientId",
        },
        {
          type: "SELECT",
          title: "Type",
          dataKey: "clientType",
          options: [
            { id: "confidential", name: "Confidential", selected: false },
            { id: "public", name: "Public", selected: false },
          ],
        },
      ],
      sort: {
        sortDataKeys: [
          { dataKey: "id", displayName: "ID", selected: false },
          { dataKey: "name", displayName: "Name", selected: true },
          { dataKey: "clientId", displayName: "Client ID", selected: false },
          { dataKey: "createdAt", displayName: "Created", selected: false },
        ],
        sortDirection: "asc",
      },
    }),
    []
  );

  if (!hasPermission("clients.read")) return null;

  return (
    <Page fillHeight maxWidth="none">
      <InfiniteScroll<OAuthClient>
        menu={menu}
        data={data}
        hasMore={hasMore}
        isLoading={isLoading}
        onQueryChange={onQueryChange}
        columns={columns}
        onReload={reload}
        onAddNew={
          hasPermission("clients.write")
            ? () => setShowCreateModal(true)
            : undefined
        }
        onRowClick={(client) =>
          navigate(`/auth-admin/oauth-clients/${client.id}`)
        }
        hideSelectColumn
      />
      <CreateClientModal
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
