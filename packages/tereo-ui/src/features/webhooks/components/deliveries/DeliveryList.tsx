import useInfiniteDeliveries from "../../api/deliveries/useInfiniteDeliveries";
import BulkRetryDeliveriesModal from "./modals/BulkRetryDeliveriesModal";
import type { WebhookDelivery, WebhookEndpoint } from "../../api/types";
import RetryDeliveryButton from "./buttons/RetryDeliveryButton";
import DeliveryDetailModal from "./modals/DeliveryDetailModal";
import { formatDateTime } from "@/utils/formatDate";
import { DeliveryStatusBadge } from "../badges";
import { useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import "../styles.css";
import {
  Button,
  InfiniteScroll,
  TableCellButton,
  type InfiniteScrollMenu,
  type TableColumn,
} from "@kosmeo-ui/react";

interface DeliveryListProps {
  endpoint: WebhookEndpoint;
}

const dash = <span className="v-muted-text">—</span>;

/** The Deliveries tab of an endpoint: history, detail, and retries. */
export const DeliveryList = ({ endpoint }: DeliveryListProps) => {
  const { hasPermission } = useAuth();
  const { data, hasMore, isLoading, onQueryChange, reload } =
    useInfiniteDeliveries(endpoint.id);
  const [openDeliveryId, setOpenDeliveryId] = useState<string | null>(null);
  const [showBulkRetry, setShowBulkRetry] = useState(false);

  const canRetry =
    hasPermission("webhooks.write") &&
    !endpoint.archivedAt &&
    endpoint.status === "ACTIVE";

  const columns: TableColumn<WebhookDelivery>[] = useMemo(
    () => [
      {
        title: "Status",
        dataKey: "status",
        width: "7rem",
        cellElement: (d) => <DeliveryStatusBadge status={d.status} />,
      },
      {
        title: "Event Type",
        dataKey: "eventType",
        cellElement: (d) => (
          <TableCellButton onClick={() => setOpenDeliveryId(d.id)}>
            <span className="v-mono">{d.eventType}</span>
          </TableCellButton>
        ),
      },
      {
        title: "Attempts",
        dataKey: "attempts",
        width: "6rem",
        align: "center",
      },
      {
        title: "Response",
        dataKey: "httpStatus",
        width: "7rem",
        align: "center",
        cellElement: (d) => d.httpStatus ?? dash,
      },
      {
        title: "Created",
        dataKey: "createdAt",
        width: "12rem",
        cellElement: (d) => formatDateTime(d.createdAt),
      },
      {
        title: "Last Attempt",
        dataKey: "lastAttemptAt",
        width: "12rem",
        cellElement: (d) =>
          d.lastAttemptAt ? formatDateTime(d.lastAttemptAt) : dash,
      },
      {
        title: "Completed",
        dataKey: "completedAt",
        width: "12rem",
        cellElement: (d) =>
          d.completedAt ? formatDateTime(d.completedAt) : dash,
      },
      {
        title: "Actions",
        disableRowClick: true,
        width: "6rem",
        align: "center",
        cellElement: (d) => (
          <RetryDeliveryButton endpoint={endpoint} delivery={d} compact />
        ),
      },
    ],
    [endpoint]
  );

  const menu: InfiniteScrollMenu = useMemo(
    () => ({
      title: "Deliveries",
      filters: [
        {
          type: "SELECT",
          title: "Status",
          dataKey: "status",
          multiSelect: true,
          options: [
            { id: "PENDING", name: "Pending", selected: false },
            { id: "SUCCESS", name: "Success", selected: false },
            { id: "FAILED", name: "Failed", selected: false },
          ],
        },
        {
          // Core filters eventType by equality only, so offer a picker of
          // this endpoint's subscriptions (plus test deliveries).
          type: "SELECT",
          title: "Event Type",
          dataKey: "eventType",
          options: [...endpoint.eventTypes, "webhook.test"].map((et) => ({
            id: et,
            name: et,
            selected: false,
          })),
        },
        {
          type: "RANGE",
          title: "Created",
          dataKey: "createdAt",
          rangeType: "DATETIME",
        },
      ],
      sort: {
        sortDataKeys: [
          { dataKey: "createdAt", displayName: "Created", selected: true },
        ],
        sortDirection: "desc",
      },
    }),
    [endpoint.eventTypes]
  );

  return (
    <>
      {canRetry && (
        <div className="t-webhook-deliveries-actions">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowBulkRetry(true)}
          >
            Retry Failed Deliveries
          </Button>
        </div>
      )}
      <InfiniteScroll<WebhookDelivery>
        menu={menu}
        data={data}
        hasMore={hasMore}
        isLoading={isLoading}
        onQueryChange={onQueryChange}
        columns={columns}
        onReload={reload}
        onRowClick={(d) => setOpenDeliveryId(d.id)}
        hideSelectColumn
      />
      <DeliveryDetailModal
        endpoint={endpoint}
        deliveryId={openDeliveryId}
        onClose={() => setOpenDeliveryId(null)}
      />
      {canRetry && (
        <BulkRetryDeliveriesModal
          endpoint={endpoint}
          show={showBulkRetry}
          onClose={() => setShowBulkRetry(false)}
        />
      )}
    </>
  );
};
