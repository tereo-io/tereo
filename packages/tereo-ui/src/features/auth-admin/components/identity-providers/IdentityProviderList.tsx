import useIdentityProviders from "../../api/identity-providers/useIdentityProviders";
import CreateIdentityProviderModal from "./modals/CreateIdentityProviderModal";
import type { IdentityProvider } from "../../api/identity-providers/types";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useState } from "react";
import {
  Badge,
  Button,
  Centered,
  Page,
  SectionHeader,
  Spinner,
  Table,
  type TableColumn,
} from "@kosmeo-ui/react";

const columns: TableColumn<IdentityProvider>[] = [
  { title: "Name", dataKey: "displayName" },
  {
    title: "Slug",
    dataKey: "slug",
    cellElement: (p) => <span className="v-mono">{p.slug}</span>,
  },
  { title: "Issuer", dataKey: "issuer" },
  {
    title: "Counts as MFA",
    dataKey: "countsAsMfa",
    width: "9rem",
    align: "center",
    cellElement: (p) => (p.countsAsMfa ? "Yes" : "No"),
  },
  {
    title: "Status",
    dataKey: "isActive",
    width: "7rem",
    align: "center",
    cellElement: (p) => (
      <Badge size="sm" subtle variant={p.isActive ? "success" : "danger"}>
        {p.isActive ? "Active" : "Inactive"}
      </Badge>
    ),
  },
];

export const IdentityProviderList = () => {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { data: providers, isLoading } = useIdentityProviders();
  const [showCreateModal, setShowCreateModal] = useState(false);

  if (!hasPermission("identity-providers.read")) return null;

  return (
    <Page padded fillHeight>
      <SectionHeader
        as="h1"
        title="Identity Providers"
        subtitle="Let people sign in with an account from another provider, such as Google."
        actions={
          hasPermission("identity-providers.write") ? (
            <Button size="sm" onClick={() => setShowCreateModal(true)}>
              Add provider
            </Button>
          ) : undefined
        }
      />
      {isLoading ? (
        <Centered>
          <Spinner size="lg" />
        </Centered>
      ) : (
        <Table
          columns={columns}
          rows={providers ?? []}
          rowKey={(p) => p.id}
          emptyMessage="No identity providers yet"
          onRowClick={(p) => navigate(`/auth-admin/identity-providers/${p.id}`)}
        />
      )}
      <CreateIdentityProviderModal
        show={showCreateModal}
        onCreate={(provider) => {
          setShowCreateModal(false);
          navigate(`/auth-admin/identity-providers/${provider.id}`);
        }}
        onClose={() => setShowCreateModal(false)}
      />
    </Page>
  );
};
