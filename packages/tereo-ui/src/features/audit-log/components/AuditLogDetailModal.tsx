import { auditLogHref, entityHistoryHref } from "../utils/urlFilters";
import useAuditLogEntry from "../api/useAuditLogEntry";
import { formatTimestamp } from "@/utils/formatDate";
import { Link, useNavigate } from "react-router-dom";
import type { AuditLogEntry } from "../types";
import type { ReactNode } from "react";
import "./AuditLogDetailModal.css";
import {
  Alert,
  Badge,
  Button,
  Centered,
  Col,
  DataTable,
  InfoRow,
  Modal,
  SectionHeader,
  Spinner,
  type TableColumn,
  type TableRow,
} from "@kosmeo-ui/react";
import {
  actionVariant,
  formatChangeValue,
  formatEntityType,
  formatOrganization,
  formatUser,
} from "../utils/format";

interface AuditLogDetailModalProps {
  /** The entry to show; `null` closes the modal. */
  entryId: string | null;
  /** The entry, when the caller already has it (e.g. from the list). */
  entry?: AuditLogEntry | null;
  onClose: () => void;
  /** Offer a link to the entity's full history. Off when already there. */
  showHistoryLink?: boolean;
  /** The list's organization filter (an org id or `none`), for loading by id. */
  organizationFilter?: string | null;
}

/**
 * One audit entry in full. Uses the entry passed in when there is one, and
 * otherwise loads it by id (`GET /entries/:id`), so `?entry=<id>` links
 * work on their own.
 */
const AuditLogDetailModal = ({
  entryId,
  entry: providedEntry,
  onClose,
  showHistoryLink = true,
  organizationFilter,
}: AuditLogDetailModalProps) => {
  const navigate = useNavigate();
  const needsFetch = !!entryId && !providedEntry;
  const {
    data: fetchedEntry,
    isLoading,
    error,
  } = useAuditLogEntry(needsFetch ? entryId : null, organizationFilter);
  const entry = providedEntry ?? fetchedEntry ?? null;

  let body: ReactNode = null;
  if (entry) {
    body = (
      <AuditLogDetail entry={entry} organizationFilter={organizationFilter} />
    );
  } else if (needsFetch && isLoading)
    body = (
      <Centered>
        <Spinner />
      </Centered>
    );
  else if (needsFetch && error)
    body = (
      <Alert variant="danger">
        Audit log entry not found, or not visible to your organization.
      </Alert>
    );

  const footerButtons = [
    <Button key="close" variant="secondary" onClick={onClose}>
      Close
    </Button>,
  ];
  if (entry && showHistoryLink) {
    footerButtons.unshift(
      <Button
        key="history"
        onClick={() =>
          navigate(
            entityHistoryHref(
              entry.entityType,
              entry.entityId,
              organizationFilter
            )
          )
        }
      >
        View entity history
      </Button>
    );
  }

  return (
    <Modal
      show={!!entryId}
      onClose={onClose}
      title="Audit Log Entry"
      size="lg"
      footerButtons={footerButtons}
    >
      {body}
    </Modal>
  );
};

interface ChangeRow {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

interface MetadataRow {
  key: string;
  value: unknown;
}

const Value = ({
  value,
  className,
}: {
  value: unknown;
  className?: string;
}) => (
  <pre className={`t-audit-value ${className ?? ""}`}>
    {formatChangeValue(value)}
  </pre>
);

const changeColumns: TableColumn<ChangeRow>[] = [
  {
    title: "Field",
    dataKey: "field",
    width: "12rem",
    cellElement: (row) => <span className="t-audit-field">{row.field}</span>,
  },
  {
    title: "Old",
    dataKey: "oldValue",
    cellElement: (row) => (
      <Value value={row.oldValue} className="t-audit-old" />
    ),
  },
  {
    title: "New",
    dataKey: "newValue",
    cellElement: (row) => (
      <Value value={row.newValue} className="t-audit-new" />
    ),
  },
];

const metadataColumns: TableColumn<MetadataRow>[] = [
  {
    title: "Key",
    dataKey: "key",
    width: "12rem",
    cellElement: (row) => <span className="t-audit-field">{row.key}</span>,
  },
  {
    title: "Value",
    dataKey: "value",
    cellElement: (row) => <Value value={row.value} />,
  },
];

/** A value plus a link to the audit log filtered on it. */
const Filterable = ({
  children,
  filter,
  organizationFilter,
}: {
  children: ReactNode;
  filter: Record<string, string>;
  organizationFilter?: string | null;
}) => (
  <span className="t-audit-inline-actions">
    <span className="t-audit-mono">{children}</span>
    <Link
      to={auditLogHref(
        organizationFilter
          ? { ...filter, organizationId: organizationFilter }
          : filter
      )}
      className="t-audit-subtle"
      title="Show all entries with this value"
    >
      filter
    </Link>
  </span>
);

const AuditLogDetail = ({
  entry,
  organizationFilter,
}: {
  entry: AuditLogEntry;
  organizationFilter?: string | null;
}) => {
  const changeRows: TableRow<ChangeRow>[] = Object.entries(
    entry.changes ?? {}
  ).map(([field, change], index) => ({
    index,
    data: { field, oldValue: change?.old, newValue: change?.new },
  }));

  const metadataRows: TableRow<MetadataRow>[] = Object.entries(
    entry.metadata ?? {}
  ).map(([key, value], index) => ({ index, data: { key, value } }));

  return (
    <Col size="md">
      <Col size="sm">
        <InfoRow
          label="Timestamp"
          value={
            <span title={entry.createdAt}>
              {formatTimestamp(entry.createdAt)}
            </span>
          }
        />
        <InfoRow
          label="Action"
          value={
            <Badge variant={actionVariant(entry.action)}>{entry.action}</Badge>
          }
        />
        <InfoRow
          label="Source"
          value={
            <Filterable
              organizationFilter={organizationFilter}
              filter={{ source: entry.source }}
            >
              {entry.source}
            </Filterable>
          }
        />
        <InfoRow
          label="Entity Type"
          value={
            <Filterable
              organizationFilter={organizationFilter}
              filter={{ entityType: entry.entityType }}
            >
              {formatEntityType(entry.entityType)}
            </Filterable>
          }
        />
        {entry.entityName && (
          <InfoRow label="Entity Name" value={entry.entityName} />
        )}
        <InfoRow
          label="Entity ID"
          value={<span className="t-audit-mono">{entry.entityId}</span>}
        />
        <InfoRow
          label="User"
          value={
            <Filterable
              organizationFilter={organizationFilter}
              filter={{ userId: entry.userId }}
            >
              {formatUser(entry.user)}{" "}
              <span className="t-audit-subtle">
                ({entry.user.name ? `${entry.user.email}, ` : ""}
                {entry.userId})
              </span>
            </Filterable>
          }
        />
        {entry.writerUserId !== entry.userId && (
          <InfoRow
            label="Written By"
            value={
              <span title="The principal core authenticated when this entry was written">
                {formatUser(entry.writer)}{" "}
                <span className="t-audit-subtle">({entry.writerUserId})</span>
              </span>
            }
          />
        )}
        <InfoRow label="Organization" value={formatOrganization(entry)} />
        {entry.ipAddress && (
          <InfoRow
            label="IP Address"
            value={
              <Filterable
                organizationFilter={organizationFilter}
                filter={{ ipAddress: entry.ipAddress }}
              >
                {entry.ipAddress}
              </Filterable>
            }
          />
        )}
        {entry.correlationId && (
          <InfoRow
            label="Correlation ID"
            value={
              <Filterable
                organizationFilter={organizationFilter}
                filter={{ correlationId: entry.correlationId }}
              >
                {entry.correlationId}
              </Filterable>
            }
          />
        )}
        <InfoRow
          label="Entry ID"
          value={<span className="t-audit-mono">{entry.id}</span>}
        />
      </Col>

      {changeRows.length > 0 && (
        <>
          <SectionHeader title="Changes" as="h4" dense />
          <DataTable<ChangeRow> columns={changeColumns} rows={changeRows} />
        </>
      )}

      {metadataRows.length > 0 && (
        <>
          <SectionHeader title="Metadata" as="h4" dense />
          <DataTable<MetadataRow>
            columns={metadataColumns}
            rows={metadataRows}
          />
        </>
      )}
    </Col>
  );
};

export default AuditLogDetailModal;
