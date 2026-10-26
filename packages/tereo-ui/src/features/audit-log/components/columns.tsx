import { formatTimestamp } from "@/utils/formatDate";
import { Link, type To } from "react-router-dom";
import type { AuditLogEntry } from "../types";
import type { ReactNode } from "react";
import {
  Badge,
  TableCellButton,
  TableCellLink,
  type TableColumn,
} from "@kosmeo-ui/react";
import {
  actionVariant,
  formatEntityType,
  formatOrganization,
  formatUser,
} from "../utils/format";

// The timestamp is the cell that opens the entry, so a keyboard reaches it.
const timestamp = (
  opener: (entry: AuditLogEntry, label: ReactNode) => ReactNode
): TableColumn<AuditLogEntry> => ({
  title: "Timestamp",
  dataKey: "createdAt",
  width: "13rem",
  cellElement: (entry) =>
    opener(
      entry,
      <span title={entry.createdAt}>{formatTimestamp(entry.createdAt)}</span>
    ),
});

const action: TableColumn<AuditLogEntry> = {
  title: "Action",
  dataKey: "action",
  width: "7rem",
  align: "center",
  cellElement: (entry) => (
    <Badge variant={actionVariant(entry.action)}>{entry.action}</Badge>
  ),
};

const user: TableColumn<AuditLogEntry> = {
  title: "User",
  dataKey: "userId",
  width: "16rem",
  cellElement: (entry) => (
    <span title={`${entry.user.email} (${entry.userId})`}>
      {formatUser(entry.user)}
    </span>
  ),
};

const organization: TableColumn<AuditLogEntry> = {
  title: "Organization",
  dataKey: "organizationId",
  width: "12rem",
  cellElement: (entry) => (
    <span title={entry.organizationId ?? undefined}>
      {formatOrganization(entry)}
    </span>
  ),
};

const source: TableColumn<AuditLogEntry> = {
  title: "Source",
  dataKey: "source",
  width: "10rem",
};

const entityType: TableColumn<AuditLogEntry> = {
  title: "Entity Type",
  dataKey: "entityType",
  width: "11rem",
  cellElement: (entry) => formatEntityType(entry.entityType),
};

const entity: TableColumn<AuditLogEntry> = {
  title: "Entity",
  dataKey: "entityName",
  cellElement: (entry) =>
    entry.entityName ? (
      <span title={entry.entityId}>{entry.entityName}</span>
    ) : (
      entry.entityId
    ),
};

const changedFields: TableColumn<AuditLogEntry> = {
  title: "Changed Fields",
  dataKey: "changes",
  cellElement: (entry) => {
    const fields = Object.keys(entry.changes ?? {});
    return fields.length > 0 ? fields.join(", ") : "-";
  },
};

/** Columns for the full audit log; `entryLink` is where an entry's detail opens. */
export const auditLogColumns = (
  entryLink: (entry: AuditLogEntry) => To
): TableColumn<AuditLogEntry>[] => [
  timestamp((entry, label) => (
    <TableCellLink as={Link} to={entryLink(entry)}>
      {label}
    </TableCellLink>
  )),
  action,
  source,
  entityType,
  entity,
  user,
];

/** The full audit log for audit-logs.admin, who can read across organizations. */
export const adminAuditLogColumns = (
  entryLink: (entry: AuditLogEntry) => To
): TableColumn<AuditLogEntry>[] => [
  ...auditLogColumns(entryLink),
  organization,
];

/** Columns for one entity's history — the entity itself is fixed. */
export const entityHistoryColumns = (
  onOpen: (entry: AuditLogEntry) => void
): TableColumn<AuditLogEntry>[] => [
  timestamp((entry, label) => (
    <TableCellButton onClick={() => onOpen(entry)}>{label}</TableCellButton>
  )),
  action,
  user,
  source,
  changedFields,
];
