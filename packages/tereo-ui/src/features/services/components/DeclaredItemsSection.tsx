import { RetirementBadge } from "./StatusBadges";
import { useState, type ReactNode } from "react";
import formatHours from "../formatHours";
import {
  BorderedSection,
  Col,
  Table,
  Tabs,
  type TableColumn,
} from "@kosmeo-ui/react";
import type {
  DeclaredBucket,
  DeclaredEventType,
  DeclaredPermission,
  DeclaredSystemRole,
  Retirable,
  ServiceDetail,
} from "../api/types";

const statusColumn = <T extends Retirable>(): TableColumn<T> => ({
  title: "Status",
  width: "7rem",
  align: "center",
  cellElement: (item) => <RetirementBadge item={item} />,
});

const mono = (value: string) => <span className="v-mono">{value}</span>;

const permissionColumns: TableColumn<DeclaredPermission>[] = [
  { title: "Name", cellElement: (p) => mono(p.name) },
  { title: "Display Name", dataKey: "displayName" },
  statusColumn(),
];

const roleColumns: TableColumn<DeclaredSystemRole>[] = [
  { title: "Name", cellElement: (r) => mono(r.name) },
  { title: "Display Name", dataKey: "displayName" },
  {
    title: "Permissions",
    cellElement: (r) =>
      r.permissions.length ? (
        <span className="v-mono">{r.permissions.join(", ")}</span>
      ) : (
        <span className="v-muted-text">None</span>
      ),
  },
  statusColumn(),
];

const bucketColumns: TableColumn<DeclaredBucket>[] = [
  { title: "Name", cellElement: (b) => mono(b.name) },
  { title: "Policy", dataKey: "policy", width: "8rem" },
  statusColumn(),
];

const eventTypeColumns: TableColumn<DeclaredEventType>[] = [
  { title: "Event Type", cellElement: (e) => mono(e.eventType) },
  {
    title: "Description",
    cellElement: (e) =>
      e.description ?? <span className="v-muted-text">—</span>,
  },
  statusColumn(),
];

/** Active items first, then missing, then retired. */
const byStatus = <T extends Retirable>(items: T[]) => {
  const rank = (i: Retirable) => (i.retiredAt ? 2 : i.missingSince ? 1 : 0);
  return [...items].sort((a, b) => rank(a) - rank(b));
};

const label = (title: string, items: Retirable[]): ReactNode => {
  const live = items.filter((i) => !i.retiredAt).length;
  return live === items.length
    ? `${title} (${items.length})`
    : `${title} (${live} + ${items.length - live} retired)`;
};

export const DeclaredItemsSection = ({
  service,
}: {
  service: ServiceDetail;
}) => {
  const [tab, setTab] = useState("permissions");
  const { permissions, systemRoles, buckets, eventTypes } = service.declared;
  const graceHours = formatHours(service.settings.retirementGraceHours);

  return (
    <BorderedSection title="Declared">
      <Col>
        <p className="v-help-text">
          What the service registered under its namespace. An item a later
          declaration stops listing is marked missing, and retires once it has
          been missing for {graceHours}: a retired permission or role grants
          nothing, a retired event type takes no new events, a retired bucket
          turns read-only. Nothing is deleted, and declaring an item again
          brings it back.
        </p>
        {!service.declaredAt && (
          <p className="v-help-text">This service has not registered yet.</p>
        )}
        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            {
              key: "permissions",
              label: label("Permissions", permissions),
              content: (
                <Table<DeclaredPermission>
                  columns={permissionColumns}
                  rows={byStatus(permissions)}
                  rowKey={(p) => p.id}
                  emptyMessage="No permissions declared."
                />
              ),
            },
            {
              key: "systemRoles",
              label: label("System Roles", systemRoles),
              content: (
                <Table<DeclaredSystemRole>
                  columns={roleColumns}
                  rows={byStatus(systemRoles)}
                  rowKey={(r) => r.id}
                  emptyMessage="No system roles declared."
                />
              ),
            },
            {
              key: "buckets",
              label: label("Buckets", buckets),
              content: (
                <Table<DeclaredBucket>
                  columns={bucketColumns}
                  rows={byStatus(buckets)}
                  rowKey={(b) => b.id}
                  emptyMessage="No buckets declared."
                />
              ),
            },
            {
              key: "eventTypes",
              label: label("Event Types", eventTypes),
              content: (
                <Table<DeclaredEventType>
                  columns={eventTypeColumns}
                  rows={byStatus(eventTypes)}
                  rowKey={(e) => e.eventType}
                  emptyMessage="No event types declared."
                />
              ),
            },
          ]}
        />
      </Col>
    </BorderedSection>
  );
};
