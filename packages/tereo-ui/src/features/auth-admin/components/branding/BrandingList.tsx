import { ProvisionedBadge } from "@/components/ProvisionedBadge";
import useBrandingList from "../../api/branding/useBrandingList";
import { PageHeader } from "@/components/PageHeader";
import { Link, useNavigate } from "react-router-dom";
import { formatDateTime } from "@/utils/formatDate";
import { useQuery } from "@tanstack/react-query";
import { useStockColors } from "@/features/auth";
import { useAuth, useAxios } from "@/lib/auth";
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

interface PickableClient {
  id: string;
  clientId: string;
  name: string;
}

export const BrandingList = () => {
  useStockColors();
  const navigate = useNavigate();
  const axios = useAxios("auth");
  const { hasPermission } = useAuth();
  const { data, isLoading } = useBrandingList();
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<string | undefined>();

  // Core lists only the clients the caller owns without clients.admin.
  const { data: clients = [] } = useQuery({
    queryKey: ["branding", "pickable-clients"],
    enabled: picking,
    queryFn: async (): Promise<PickableClient[]> => {
      const res = await axios.get("/v1/admin/clients");
      return res.data.data ?? [];
    },
  });

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
  const options = clients
    .filter((c) => !branded.has(c.id))
    .map((c) => ({ value: c.id, label: `${c.name} (${c.clientId})` }));
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
        <Select
          label="Client"
          placeholder="Choose a client"
          value={chosen}
          options={options}
          onChange={setChosen}
        />
      </Modal>
    </Page>
  );
};
