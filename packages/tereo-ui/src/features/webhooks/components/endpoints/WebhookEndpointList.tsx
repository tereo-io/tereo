import useInfiniteWebhookEndpoints from "../../api/endpoints/useInfiniteWebhookEndpoints";
import CreateWebhookEndpointModal from "./modals/CreateWebhookEndpointModal";
import useWebhooksOrganization from "../../hooks/useWebhooksOrganization";
import { ProvisionedBadge } from "@/components/ProvisionedBadge";
import type { WebhookEndpoint } from "../../api/types";
import { Link, useNavigate } from "react-router-dom";
import { EndpointStatusBadges } from "../badges";
import { formatDate } from "@/utils/formatDate";
import { useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import "../styles.css";
import {
  InfiniteScroll,
  Page,
  TableCellLink,
  type TableColumn,
  type InfiniteScrollMenu,
} from "@kosmeo-ui/react";

const summarizeEventTypes = (eventTypes: string[]) => {
  if (eventTypes.length <= 2) return eventTypes.join(", ");
  return `${eventTypes.slice(0, 2).join(", ")} +${eventTypes.length - 2} more`;
};

export const WebhookEndpointList = () => {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { search } = useWebhooksOrganization();
  const { data, hasMore, isLoading, onQueryChange, reload } =
    useInfiniteWebhookEndpoints();
  const [showCreateModal, setShowCreateModal] = useState(false);

  const columns: TableColumn<WebhookEndpoint>[] = useMemo(
    () => [
      {
        title: "URL",
        dataKey: "url",
        minWidth: "16rem",
        cellElement: (ep) => (
          <span className="t-webhook-url">
            <TableCellLink
              as={Link}
              to={{ pathname: `/webhooks/endpoints/${ep.id}`, search }}
            >
              {ep.url}
            </TableCellLink>{" "}
            {ep.provisioned && <ProvisionedBadge />}
          </span>
        ),
      },
      {
        title: "Description",
        dataKey: "description",
        cellElement: (ep) =>
          ep.description || <span className="v-muted-text">—</span>,
      },
      {
        title: "Event Types",
        dataKey: "eventTypes",
        cellElement: (ep) => (
          <span title={ep.eventTypes.join("\n")}>
            {summarizeEventTypes(ep.eventTypes)}
          </span>
        ),
      },
      {
        title: "Status",
        dataKey: "status",
        width: "11rem",
        cellElement: (ep) => <EndpointStatusBadges endpoint={ep} />,
      },
      {
        title: "Created",
        dataKey: "createdAt",
        width: "9rem",
        cellElement: (ep) => formatDate(ep.createdAt),
      },
    ],
    [search]
  );

  const menu: InfiniteScrollMenu = useMemo(
    () => ({
      title: "Webhook Endpoints",
      titleAs: "h1",
      filters: [
        { type: "SEARCH", title: "URL", dataKey: "url" },
        { type: "SEARCH", title: "Description", dataKey: "description" },
        { type: "SEARCH", title: "Event Type", dataKey: "eventType" },
        {
          type: "SELECT",
          title: "Status",
          dataKey: "status",
          multiSelect: true,
          options: [
            { id: "ACTIVE", name: "Active", selected: false },
            { id: "PAUSED", name: "Paused", selected: false },
            { id: "DISABLED", name: "Disabled", selected: false },
          ],
        },
        {
          type: "SELECT",
          title: "Archived",
          dataKey: "archived",
          options: [
            { id: "false", name: "Not archived", selected: false },
            { id: "true", name: "Archived", selected: false },
          ],
        },
      ],
      sort: {
        sortDataKeys: [
          { dataKey: "createdAt", displayName: "Created", selected: true },
          { dataKey: "updatedAt", displayName: "Updated", selected: false },
        ],
        sortDirection: "desc",
      },
    }),
    []
  );

  if (!hasPermission("webhooks.read")) return null;

  return (
    <Page fillHeight maxWidth="none">
      <InfiniteScroll<WebhookEndpoint>
        menu={menu}
        data={data}
        hasMore={hasMore}
        isLoading={isLoading}
        onQueryChange={onQueryChange}
        columns={columns}
        onReload={reload}
        onAddNew={
          hasPermission("webhooks.write")
            ? () => setShowCreateModal(true)
            : undefined
        }
        onRowClick={(ep) =>
          navigate({ pathname: `/webhooks/endpoints/${ep.id}`, search })
        }
        hideSelectColumn
      />
      <CreateWebhookEndpointModal
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
