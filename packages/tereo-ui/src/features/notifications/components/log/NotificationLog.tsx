import useInfiniteNotificationLog from "../../api/log/useInfiniteNotificationLog";
import { NotificationDetailModal } from "./NotificationDetailModal";
import { NotificationStatusBadge } from "./badges";
import { recipientsText } from "./recipients";
import formatDate from "@/utils/formatDate";
import { useMemo, useState } from "react";
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
  type TableColumn,
} from "@kosmeo-ui/react";
import type {
  NotificationChannel,
  NotificationLogFilters,
  NotificationLogListItem,
  NotificationStatus,
} from "../../api/types";

const STATUSES: NotificationStatus[] = ["pending", "sent", "partial", "failed"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The notification log: every send, newest first, with filters and a detail dialog. */
export const NotificationLog = () => {
  const [filters, setFilters] = useState<NotificationLogFilters>({});
  const [recipient, setRecipient] = useState("");
  const [sender, setSender] = useState("");
  const [senderError, setSenderError] = useState<string>();
  const [openId, setOpenId] = useState<string | null>(null);
  const log = useInfiniteNotificationLog(filters);

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
          <span className="t-notif-mono" title={n.senderUserId}>
            {n.senderUserId.slice(0, 8)}
          </span>
        ),
      },
      {
        title: "Subject",
        dataKey: "summary",
        cellElement: (n) => n.summary ?? "—",
      },
      {
        title: "Recipients",
        cellElement: (n) => recipientsText(n.recipients),
      },
      {
        title: "Created",
        dataKey: "createdAt",
        width: "14rem",
        cellElement: (n) => formatDate(n.createdAt),
      },
      {
        title: "Sent",
        dataKey: "sentAt",
        width: "14rem",
        cellElement: (n) => (n.sentAt ? formatDate(n.sentAt) : "—"),
      },
    ],
    []
  );

  return (
    <Page padded fillHeight>
      <h2>Log</h2>
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
          options={STATUSES.map((s) => ({ value: s, label: s }))}
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
