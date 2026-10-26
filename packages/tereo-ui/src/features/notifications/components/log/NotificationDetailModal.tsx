import useNotificationLogEntry from "../../api/log/useNotificationLogEntry";
import useRetryNotification from "../../api/log/useRetryNotification";
import type { NotificationLogDetail } from "../../api/types";
import { formatDateTime } from "@/utils/formatDate";
import { NotificationStatusBadge } from "./badges";
import { recipientsText } from "./recipients";
import { useAuth } from "@/lib/auth";
import "../styles.css";
import {
  Button,
  Centered,
  Col,
  EmptyState,
  InfoRow,
  Modal,
  SectionHeader,
  Spinner,
} from "@kosmeo-ui/react";

interface NotificationDetailModalProps {
  notificationId: string | null;
  onClose: () => void;
}

const dash = <span className="v-muted-text">—</span>;

const text = (value: unknown) =>
  typeof value === "string" && value ? value : null;

const kilobytes = (bytes: number) =>
  `${Math.max(1, Math.round(bytes / 1024))} KB`;

export const NotificationDetailModal = ({
  notificationId,
  onClose,
}: NotificationDetailModalProps) => {
  const { hasPermission } = useAuth();
  const { data, isLoading } = useNotificationLogEntry(notificationId);
  const retry = useRetryNotification();

  const canRetry =
    hasPermission("notifications.admin") &&
    !!data?.deliveries.some((d) => d.status === "failed");

  return (
    <Modal
      show={!!notificationId}
      onClose={onClose}
      title="Notification"
      size="lg"
      footerButtons={[
        ...(canRetry && notificationId
          ? [
              <Button
                key="retry"
                isLoading={retry.isPending}
                onClick={() => retry.mutate(notificationId)}
              >
                Retry
              </Button>,
            ]
          : []),
        <Button key="close" variant="secondary" onClick={onClose}>
          Close
        </Button>,
      ]}
    >
      {isLoading ? (
        <Centered>
          <Spinner />
        </Centered>
      ) : data ? (
        <Detail notification={data} />
      ) : (
        <EmptyState>Notification not found</EmptyState>
      )}
    </Modal>
  );
};

const Detail = ({
  notification: n,
}: {
  notification: NotificationLogDetail;
}) => {
  const content = n.content;
  const subject = text(content?.subject);
  const body = text(content?.text) ?? text(content?.html);

  return (
    <Col size="md">
      <Col size="sm">
        <InfoRow
          label="ID"
          value={<span className="t-notif-mono">{n.id}</span>}
        />
        <InfoRow
          label="Status"
          value={<NotificationStatusBadge status={n.status} />}
        />
        <InfoRow label="Channel" value={n.channel} />
        <InfoRow
          label="Sender"
          value={
            <span title={n.senderUserId}>
              {n.sender.name
                ? `${n.sender.name} (${n.sender.email})`
                : n.sender.email}
            </span>
          }
        />
        <InfoRow label="Recipients" value={recipientsText(n.recipients)} />
        <InfoRow label="Created" value={formatDateTime(n.createdAt)} />
      </Col>

      <SectionHeader title="Content" as="h4" dense />
      {content ? (
        <Col size="sm">
          <InfoRow label="Subject" value={subject ?? dash} />
          {body ? (
            <pre className="t-notif-code">{body}</pre>
          ) : (
            <EmptyState>No body</EmptyState>
          )}
        </Col>
      ) : (
        <EmptyState>Content removed after sending</EmptyState>
      )}

      <SectionHeader title="Attachments" as="h4" dense />
      {n.attachments.length ? (
        <ul className="t-notif-list">
          {n.attachments.map((a) => (
            <li key={a.versionId}>
              {a.filename} ({a.contentType}, {kilobytes(a.size)})
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState>No attachments</EmptyState>
      )}

      <SectionHeader title="Deliveries" as="h4" dense />
      {n.deliveries.map((d) => (
        <Col size="sm" key={d.id}>
          <InfoRow
            label="Status"
            value={<NotificationStatusBadge status={d.status} />}
          />
          <InfoRow
            label="To"
            value={d.recipients.map((r) => r.address).join(", ")}
          />
          <InfoRow label="Attempts" value={d.attempts} />
          <InfoRow
            label="Sent"
            value={d.sentAt ? formatDateTime(d.sentAt) : dash}
          />
          {d.lastError && (
            <InfoRow
              label="Last error"
              value={<pre className="t-notif-code">{d.lastError}</pre>}
            />
          )}
          {d.providerResponse && (
            <InfoRow
              label="Provider response"
              value={<pre className="t-notif-code">{d.providerResponse}</pre>}
            />
          )}
        </Col>
      ))}
    </Col>
  );
};
