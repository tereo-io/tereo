import useSetDefaultConnection from "../../api/connections/useSetDefaultConnection";
import useDeleteConnection from "../../api/connections/useDeleteConnection";
import useConnections from "../../api/connections/useConnections";
import type { NotificationConnection } from "../../api/types";
import { ConnectionFormModal } from "./ConnectionFormModal";
import { TestConnectionModal } from "./TestConnectionModal";
import { useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import "../styles.css";
import {
  faCheck,
  faPaperPlane,
  faPen,
  faPlus,
  faTrash,
} from "@fortawesome/free-solid-svg-icons";
import {
  Alert,
  Badge,
  ConfirmationModal,
  EmptyState,
  IconButton,
  Page,
  Row,
  RowActions,
  Spinner,
  Table,
  type TableColumn,
} from "@kosmeo-ui/react";

const endpointOf = (c: NotificationConnection) => {
  const { host, port } = c.settings as { host?: string; port?: number };
  return host ? `${host}${port ? `:${port}` : ""}` : "";
};

export const ConnectionList = () => {
  const { hasPermission } = useAuth();
  const canAdmin = hasPermission("notifications.admin");
  const { data = [], isLoading, error } = useConnections();
  const setDefault = useSetDefaultConnection();
  const remove = useDeleteConnection();

  const [editing, setEditing] = useState<NotificationConnection | null>(null);
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState<NotificationConnection | null>(null);
  const [deleting, setDeleting] = useState<NotificationConnection | null>(null);

  const columns: TableColumn<NotificationConnection>[] = useMemo(
    () => [
      {
        title: "Name",
        dataKey: "displayName",
        cellElement: (c) => (
          <div>
            <div>{c.displayName}</div>
            <div className="v-muted-text t-notif-mono">{c.slug}</div>
          </div>
        ),
      },
      { title: "Channel", dataKey: "channel", width: "7rem" },
      {
        title: "Server",
        dataKey: "settings",
        cellElement: (c) => (
          <span className="t-notif-mono">{endpointOf(c)}</span>
        ),
      },
      {
        title: "Status",
        dataKey: "isEnabled",
        width: "12rem",
        cellElement: (c) => (
          <Row size="sm" align="center" wrap inline>
            {c.isDefault && (
              <Badge size="sm" subtle variant="primary">
                Default
              </Badge>
            )}
            {c.isEnabled ? (
              <Badge size="sm" subtle variant="success">
                Enabled
              </Badge>
            ) : (
              <Badge size="sm" subtle variant="warning">
                Disabled
              </Badge>
            )}
          </Row>
        ),
      },
      {
        title: "Limit",
        dataKey: "maxPerMinute",
        width: "8rem",
        cellElement: (c) =>
          c.maxPerMinute ? (
            `${c.maxPerMinute} / min`
          ) : (
            <span className="v-muted-text">None</span>
          ),
      },
      ...(canAdmin
        ? [
            {
              title: "",
              dataKey: "id",
              width: "10rem",
              cellElement: (c: NotificationConnection) => (
                <RowActions align="end">
                  <IconButton
                    icon={faPaperPlane}
                    title="Send test"
                    variant="secondary"
                    size="sm"
                    onClick={() => setTesting(c)}
                  />
                  {!c.isDefault && (
                    <IconButton
                      icon={faCheck}
                      title="Make default"
                      variant="secondary"
                      size="sm"
                      onClick={() => setDefault.mutate(c.id)}
                    />
                  )}
                  <IconButton
                    icon={faPen}
                    title="Edit"
                    variant="secondary"
                    size="sm"
                    onClick={() => setEditing(c)}
                  />
                  <IconButton
                    icon={faTrash}
                    title="Delete"
                    variant="danger"
                    size="sm"
                    onClick={() => setDeleting(c)}
                  />
                </RowActions>
              ),
            } satisfies TableColumn<NotificationConnection>,
          ]
        : []),
    ],
    [canAdmin, setDefault]
  );

  if (!hasPermission("notifications.read")) return null;

  return (
    <Page padded fillHeight>
      <Row align="center" justify="between">
        <h2>Connections</h2>
        {canAdmin && (
          <IconButton icon={faPlus} size="sm" onClick={() => setCreating(true)}>
            New connection
          </IconButton>
        )}
      </Row>
      {error && <Alert variant="danger">Failed to load the connections.</Alert>}
      {isLoading ? (
        <Spinner size="lg" />
      ) : (
        <Table<NotificationConnection>
          columns={columns}
          rows={data}
          rowKey={(c) => c.id}
          emptyMessage={
            <EmptyState layout="block">
              No connections yet. A connection is how core reaches a mail
              server; sends fail until one exists.
            </EmptyState>
          }
        />
      )}

      <ConnectionFormModal show={creating} onClose={() => setCreating(false)} />
      <ConnectionFormModal
        show={!!editing}
        connection={editing ?? undefined}
        onClose={() => setEditing(null)}
      />
      <TestConnectionModal
        show={!!testing}
        connection={testing}
        onClose={() => setTesting(null)}
      />
      <ConfirmationModal
        show={!!deleting}
        handleHide={() => setDeleting(null)}
        handleConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, { onSettled: () => setDeleting(null) })
        }
        title="Delete connection"
        body={`Delete ${deleting?.displayName ?? "this connection"}? Once a notification has used it, delete is refused and disabling it is the way to retire it.`}
        confirmButtonText={remove.isPending ? "Deleting..." : "Delete"}
        isLoading={remove.isPending}
      />
    </Page>
  );
};
