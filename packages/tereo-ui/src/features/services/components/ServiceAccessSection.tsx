import useDecideServiceAccess from "../api/useDecideServiceAccess";
import type { ServiceAccess, ServiceDetail } from "../api/types";
import { AccessStatusBadge } from "./StatusBadges";
import { AccessDecision } from "./AccessDecision";
import { AccessTarget } from "./AccessTarget";
import { useAuth } from "@/lib/auth";
import {
  BorderedSection,
  Button,
  Col,
  RowActions,
  Table,
  type TableColumn,
} from "@kosmeo-ui/react";

interface ServiceAccessSectionProps {
  service: ServiceDetail;
  /** Core's own row: its access is not decided through the admin API. */
  readOnly: boolean;
}

const KIND_LABEL = { role: "Role", audience: "Audience" } as const;

export const ServiceAccessSection = ({
  service,
  readOnly,
}: ServiceAccessSectionProps) => {
  const { hasPermission } = useAuth();
  const canDecide = !readOnly && hasPermission("services.approve");
  const approve = useDecideServiceAccess("approve");
  const revoke = useDecideServiceAccess("revoke");
  const busy = approve.isPending || revoke.isPending;

  const pending = service.access.filter((a) => a.status === "pending");

  const decide = (mutation: typeof approve, ids: string[]) =>
    mutation.mutate({ serviceId: service.id, ids });

  const columns: TableColumn<ServiceAccess>[] = [
    {
      title: "Kind",
      dataKey: "kind",
      width: "7rem",
      cellElement: (a) => KIND_LABEL[a.kind],
    },
    {
      title: "Target",
      dataKey: "target",
      cellElement: (a) => <AccessTarget access={a} />,
    },
    {
      title: "Status",
      dataKey: "status",
      width: "7rem",
      cellElement: (a) => <AccessStatusBadge status={a.status} />,
    },
    {
      title: "Requested",
      dataKey: "requestedAt",
      cellElement: (a) => new Date(a.requestedAt).toLocaleString(),
    },
    {
      title: "Decided",
      dataKey: "decidedAt",
      cellElement: (a) => <AccessDecision access={a} />,
    },
    {
      title: "Actions",
      width: "12rem",
      align: "right",
      hidden: !canDecide,
      cellElement: (a) => (
        <RowActions align="end">
          {a.status !== "approved" && (
            <Button
              size="sm"
              variant="success"
              disabled={busy}
              onClick={() => decide(approve, [a.id])}
            >
              Approve
            </Button>
          )}
          {a.status !== "revoked" && (
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => decide(revoke, [a.id])}
            >
              {a.status === "pending" && !a.decidedAt ? "Deny" : "Revoke"}
            </Button>
          )}
        </RowActions>
      ),
    },
  ];

  return (
    <BorderedSection
      title={`Requested Access${pending.length ? ` (${pending.length} pending)` : ""}`}
      actions={
        canDecide && pending.length > 1 ? (
          <Button
            size="sm"
            variant="success"
            isLoading={approve.isPending}
            disabled={busy}
            onClick={() =>
              decide(
                approve,
                pending.map((a) => a.id)
              )
            }
          >
            Approve All Pending
          </Button>
        ) : undefined
      }
    >
      <Col>
        <p className="v-help-text">
          Roles and audiences the service asks for when it registers. Until
          approved, calls that need them get 403. Approving a role assigns it to
          the service account; approving an audience lets that service
          introspect this one&apos;s tokens. Revoking takes it away and revokes
          the service&apos;s current tokens, so its next call gets a token
          without it. A revoked item stays revoked when requested again.
        </p>
        <Table<ServiceAccess>
          columns={columns}
          rows={service.access}
          rowKey={(a) => a.id}
          emptyMessage="This service has requested no access."
        />
      </Col>
    </BorderedSection>
  );
};
