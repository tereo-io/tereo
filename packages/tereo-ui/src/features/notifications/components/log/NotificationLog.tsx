import useInfiniteNotificationLog from "../../api/log/useInfiniteNotificationLog";
import { NotificationDetailModal } from "./NotificationDetailModal";
import { NotificationStatusBadge, STATUS_LABEL } from "./badges";
import { PageHeader } from "@/components/PageHeader";
import { formatDateTime } from "@/utils/formatDate";
import { recipientsText } from "./recipients";
import { useMemo, useState } from "react";
import { userLabel } from "@/lib/refs";
import "../styles.css";
import {
  Alert,
  Button,
  DateTimeInput,
  EmptyState,
  Input,
  Page,
  Select,
  Spinner,
  Table,
  TableCellButton,
  type TableColumn,
} from "@kosmeo-ui/react";
import type {
  NotificationChannel,
  NotificationLogFilters,
  NotificationLogListItem,
  NotificationLogOrder,
  NotificationStatus,
} from "../../api/types";

const STATUSES: NotificationStatus[] = ["pending", "sent", "partial", "failed"];
const PAGE_SIZES = ["25", "50", "100"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The notification log: every send, newest first by default, with filters and a detail dialog. */
export const NotificationLog = () => {
  const [filters, setFilters] = useState<NotificationLogFilters>({});
  const [recipient, setRecipient] = useState("");
  const [sender, setSender] = useState("");
  const [senderError, setSenderError] = useState<string>();
  const [openId, setOpenId] = useState<string | null>(null);
  const [order, setOrder] = useState<NotificationLogOrder>({
    limit: 25,
    sortDir: "desc",
  });
  const log = useInfiniteNotificationLog(filters, order);

  const rows = useMemo(
    () => log.data?.pages.flatMap((p) => p.data) ?? [],
    [log.data]
  );

  const update = (patch: Partial<NotificationLogFilters>) =>
    setFilters((f) => ({ ...f, ...patch }));

  const applyText = (e: React.FormEvent) => {
    e.preventDefault();
    const senderUserId = sender.trim();
    // A malformed ID keeps the sender filter as it was rather than dropping it.
    const senderValid = senderUserId === "" || UUID.test(senderUserId);
    setSenderError(senderValid ? undefined : "Enter a user ID (UUID)");
    update({
      recipient: recipient.trim() || undefined,
      ...(senderValid && { senderUserId: senderUserId || undefined }),
    });
  };

  const columns: TableColumn<NotificationLogListItem>[] = useMemo(
    () => [
      { title: "Channel", dataKey: "channel", width: "6rem" },
      {
        title: "Status",
        dataKey: "status",
        width: "7rem",
        cellElement: (n) => <NotificationStatusBadge status={n.status} />,
      },
      {
        title: "Sender",
        dataKey: "senderUserId",
        cellElement: (n) => (
          <span title={n.sender.email}>{userLabel(n.sender)}</span>
        ),
      },
      {
        title: "Subject",
        dataKey: "summary",
        cellElement: (n) => (
          <TableCellButton onClick={() => setOpenId(n.id)}>
            {n.summary ?? "No subject"}
          </TableCellButton>
        ),
      },
      {
        title: "Recipients",
        cellElement: (n) => recipientsText(n.recipients),
      },
      {
        title: "Created",
        dataKey: "createdAt",
        width: "14rem",
        cellElement: (n) => formatDateTime(n.createdAt),
      },
      {
        title: "Sent",
        dataKey: "sentAt",
        width: "14rem",
        cellElement: (n) => (n.sentAt ? formatDateTime(n.sentAt) : "—"),
      },
    ],
    []
  );

  return (
    <Page padded fillHeight>
      <PageHeader title="Notification Log" />
      <form className="t-notif-filters" onSubmit={applyText}>
        <Select<NotificationChannel | "">
          label="Channel"
          placeholder="All"
          value={filters.channel ?? ""}
          options={[{ value: "email", label: "Email" }]}
          onChange={(v) => update({ channel: v || undefined })}
        />
        <Select<NotificationStatus | "">
          label="Status"
          placeholder="All"
          value={filters.status ?? ""}
          options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
          onChange={(v) => update({ status: v || undefined })}
        />
        <Input
          label="Recipient"
          type="email"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          onBlur={applyText}
        />
        <Input
          label="Sender (user ID)"
          error={senderError}
          value={sender}
          onChange={(e) => setSender(e.target.value)}
          onBlur={applyText}
        />
        <DateTimeInput
          label="Created from"
          value={filters.createdFrom ?? null}
          onChange={(iso) => update({ createdFrom: iso ?? undefined })}
        />
        <DateTimeInput
          label="Created to"
          value={filters.createdTo ?? null}
          onChange={(iso) => update({ createdTo: iso ?? undefined })}
        />
        <Button type="submit" variant="secondary">
          Apply
        </Button>
        <Select<NotificationLogOrder["sortDir"]>
          label="Order"
          value={order.sortDir}
          options={[
            { value: "desc", label: "Newest first" },
            { value: "asc", label: "Oldest first" },
          ]}
          onChange={(v) => v && setOrder((o) => ({ ...o, sortDir: v }))}
        />
        <Select<(typeof PAGE_SIZES)[number]>
          label="Page size"
          value={String(order.limit) as (typeof PAGE_SIZES)[number]}
          options={PAGE_SIZES.map((n) => ({ value: n, label: n }))}
          onChange={(v) => v && setOrder((o) => ({ ...o, limit: Number(v) }))}
        />
      </form>

      {log.isLoading ? (
        <Spinner />
      ) : log.error ? (
        <Alert variant="danger">Failed to load the notification log.</Alert>
      ) : (
        <>
          <Table<NotificationLogListItem>
            columns={columns}
            rows={rows}
            rowKey={(n) => n.id}
            onRowClick={(n) => setOpenId(n.id)}
            emptyMessage={<EmptyState>No notifications found</EmptyState>}
          />
          {log.hasNextPage && (
            <div className="t-notif-more">
              <Button
                variant="secondary"
                isLoading={log.isFetchingNextPage}
                onClick={() => log.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          )}
        </>
      )}

      <NotificationDetailModal
        notificationId={openId}
        onClose={() => setOpenId(null)}
      />
    </Page>
  );
};
