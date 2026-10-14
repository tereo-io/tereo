import useDeleteProviderDomain from "../../api/identity-providers/useDeleteProviderDomain";
import useProviderDomains from "../../api/identity-providers/useProviderDomains";
import type { ProviderDomain } from "../../api/identity-providers/types";
import { faEdit, faTrash } from "@fortawesome/free-solid-svg-icons";
import DomainModal from "./modals/DomainModal";
import { useAuth } from "@/lib/auth";
import { useState } from "react";
import "./styles.css";
import {
  Badge,
  Button,
  Card,
  ConfirmationModal,
  IconButton,
  SectionHeader,
  Spinner,
  Table,
  type TableColumn,
} from "@kosmeo-ui/react";

interface ProviderDomainsProps {
  providerId: string;
}

/** The email domains a provider serves, and what signing in from one does. */
export const ProviderDomains = ({ providerId }: ProviderDomainsProps) => {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission("identity-providers.write");
  const { data: domains, isLoading } = useProviderDomains(providerId);
  const deleteMutation = useDeleteProviderDomain();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ProviderDomain | null>(null);
  const [removing, setRemoving] = useState<ProviderDomain | null>(null);

  const columns: TableColumn<ProviderDomain>[] = [
    {
      title: "Domain",
      dataKey: "domain",
      cellElement: (d) => <span className="v-mono">{d.domain}</span>,
    },
    {
      title: "Organization",
      dataKey: "organization",
      cellElement: (d) => d.organization.name,
    },
    {
      title: "Default roles",
      dataKey: "roles",
      cellElement: (d) =>
        d.roles.length ? (
          <div className="t-idp-roles">
            {d.roles.map((r) => (
              <Badge key={r.id} size="sm" variant="secondary">
                {r.displayName}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="v-muted-text">-</span>
        ),
    },
    {
      title: "Auto-accept",
      dataKey: "autoAccept",
      width: "8rem",
      align: "center",
      cellElement: (d) => (d.autoAccept ? "Yes" : "No"),
    },
    {
      title: "SSO-only",
      dataKey: "ssoOnly",
      width: "7rem",
      align: "center",
      cellElement: (d) => (d.ssoOnly ? "Yes" : "No"),
    },
    {
      title: "Actions",
      hidden: !canWrite,
      width: "7rem",
      align: "center",
      cellElement: (d) => (
        <>
          <IconButton
            icon={faEdit}
            title="Edit"
            variant="secondary"
            size="sm"
            onClick={() => setEditing(d)}
          />
          <IconButton
            icon={faTrash}
            title="Remove"
            variant="danger"
            size="sm"
            onClick={() => setRemoving(d)}
          />
        </>
      ),
    },
  ];

  return (
    <Card>
      <SectionHeader
        title="Domains"
        subtitle="Who may sign in through this provider, by email domain."
        actions={
          canWrite ? (
            <Button size="sm" onClick={() => setAdding(true)}>
              Add domain
            </Button>
          ) : undefined
        }
      />
      {isLoading ? (
        <Spinner size="md" />
      ) : (
        <Table
          columns={columns}
          rows={domains ?? []}
          rowKey={(d) => d.id}
          hover={false}
          emptyMessage="No domains. Only invited people can sign in through this provider."
        />
      )}
      <DomainModal
        providerId={providerId}
        show={adding}
        onClose={() => setAdding(false)}
      />
      {editing && (
        <DomainModal
          providerId={providerId}
          domain={editing}
          show
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmationModal
        show={!!removing}
        handleHide={() => setRemoving(null)}
        handleConfirm={() =>
          removing &&
          deleteMutation.mutate(
            { providerId, domainId: removing.id },
            { onSettled: () => setRemoving(null) }
          )
        }
        title="Remove Domain"
        body={`Remove ${removing?.domain}? People with that email domain are no longer accepted automatically or kept to this provider.`}
        confirmButtonText={deleteMutation.isPending ? "Removing..." : "Remove"}
      />
    </Card>
  );
};
