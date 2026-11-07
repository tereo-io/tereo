import useInfiniteClients from "../../api/oauth-clients/useInfiniteClients";
import { ProvisionedBadge } from "@/components/ProvisionedBadge";
import useBrandingList from "../../api/branding/useBrandingList";
import { PageHeader } from "@/components/PageHeader";
import { Link, useNavigate } from "react-router-dom";
import { formatDateTime } from "@/utils/formatDate";
import { useStockColors } from "@/features/auth";
import { useAuth } from "@/lib/auth";
import { useState } from "react";
import "./styles.css";
import {
  Button,
  Centered,
  EmptyState,
  Modal,
  Page,
  Select,
  Spinner,
} from "@kosmeo-ui/react";

const PAGE_QUERY = "limit=25";

/** Core lists only the clients the caller owns without clients.admin. */
const ClientPicker = ({
  branded,
  value,
  onChange,
}: {
  branded: Set<string>;
  value: string | undefined;
  onChange: (id: string | undefined) => void;
}) => {
  const { data, hasMore, isLoading, onQueryChange } = useInfiniteClients();
  const options = data
    .filter((c) => !branded.has(c.id))
    .map((c) => ({ value: c.id, label: `${c.name} (${c.clientId})` }));
  return (
    <>
      <Select
        label="Client"
        placeholder="Choose a client"
        value={value}
        options={options}
        onChange={onChange}
      />
      {hasMore && (
        <Button
          variant="secondary"
          isLoading={isLoading}
          onClick={() => onQueryChange(PAGE_QUERY)}
        >
          Load more clients
        </Button>
      )}
    </>
  );
};

export const BrandingList = () => {
  useStockColors();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { data, isLoading } = useBrandingList();
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<string | undefined>();

  if (!hasPermission("branding.read")) return null;

  if (isLoading) {
    return (
      <Page padded fillHeight>
        <Centered>
          <Spinner size="lg" />
        </Centered>
      </Page>
    );
  }

  const branded = new Set((data?.clients ?? []).map((c) => c.id));
  const empty = !data?.default && !data?.clients.length;

  return (
    <Page padded fillHeight>
      <PageHeader
        title="Branding"
        subtitle="Sign-in page branding for the default and for individual clients"
        actions={[
          ...(hasPermission("branding.admin") && !data?.default
            ? [
                <Link key="default" to="/auth-admin/branding/default">
                  Set default branding
                </Link>,
              ]
            : []),
          ...(hasPermission("branding.write")
            ? [
                <Button
                  key="brand"
                  variant="secondary"
                  onClick={() => setPicking(true)}
                >
                  Brand a client…
                </Button>,
              ]
            : []),
        ]}
      />
      {empty ? (
        <EmptyState layout="block">No branding yet</EmptyState>
      ) : (
        <table className="t-branding-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Client ID</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {data?.default && (
              <tr>
                <td>
                  <Link to="/auth-admin/branding/default">Default</Link>{" "}
                  {data.default.provisioned && <ProvisionedBadge />}
                </td>
                <td>—</td>
                <td>
                  {data.default.updatedAt
                    ? formatDateTime(data.default.updatedAt)
                    : "—"}
                </td>
              </tr>
            )}
            {data?.clients.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link to={`/auth-admin/branding/clients/${c.id}`}>
                    {c.name}
                  </Link>{" "}
                  {c.provisioned && <ProvisionedBadge />}
                </td>
                <td>{c.clientId}</td>
                <td>{formatDateTime(c.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Modal
        show={picking}
        onClose={() => setPicking(false)}
        title="Brand a client"
        footerButtons={[
          <Button
            key="cancel"
            variant="secondary"
            onClick={() => setPicking(false)}
          >
            Cancel
          </Button>,
          <Button
            key="go"
            disabled={!chosen}
            onClick={() => navigate(`/auth-admin/branding/clients/${chosen}`)}
          >
            Continue
          </Button>,
        ]}
      >
        <ClientPicker branded={branded} value={chosen} onChange={setChosen} />
      </Modal>
    </Page>
  );
};
