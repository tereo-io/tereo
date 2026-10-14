import useDisconnectIdentity from "../../api/account/useDisconnectIdentity";
import type { ConnectedIdentity } from "../../api/identity-providers/types";
import { identityErrorMessage } from "../../api/identity-providers/errors";
import useAccountIdentities from "../../api/account/useAccountIdentities";
import useConnectIdentity from "../../api/account/useConnectIdentity";
import { useSearchParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";
import {
  Button,
  Card,
  ConfirmationModal,
  EmptyState,
  SectionHeader,
  Table,
  type TableColumn,
} from "@kosmeo-ui/react";
import {
  isReauthRequired,
  restartLoginFresh,
  upstreamErrorMessage,
  useUpstreamProviders,
} from "@/features/auth";

const ACCOUNT_PATH = "/account";

/** Providers linked to the signed-in account, with connect and disconnect. */
export const ConnectedAccounts = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: identities } = useAccountIdentities();
  const { data: providers } = useUpstreamProviders();
  const connect = useConnectIdentity();
  const disconnect = useDisconnectIdentity();
  const [toRemove, setToRemove] = useState<ConnectedIdentity | null>(null);

  const linked = searchParams.get("linked");
  const errorCode = searchParams.get("error");

  // Linking ends on this page with the outcome in the query; show it once.
  useEffect(() => {
    if (!linked && !errorCode) return;
    if (linked) {
      const name =
        providers?.find((p) => p.slug === linked)?.displayName ?? linked;
      toast.success(`${name} connected`, { toastId: `linked-${linked}` });
    } else if (errorCode) {
      toast.error(
        upstreamErrorMessage(errorCode) ?? "Connecting the account failed",
        { toastId: `link-error-${errorCode}` }
      );
    }
    setSearchParams({}, { replace: true });
  }, [linked, errorCode, providers, setSearchParams]);

  const handleError = (error: unknown, fallback: string) => {
    if (isReauthRequired(error)) {
      toast.info("Please sign in again to confirm this change.");
      void restartLoginFresh(ACCOUNT_PATH);
      return;
    }
    toast.error(identityErrorMessage(error, fallback));
  };

  const handleConnect = (slug: string) =>
    connect.mutate(slug, {
      onError: (error) => handleError(error, "Failed to connect the account"),
    });

  const handleDisconnect = () => {
    if (!toRemove) return;
    disconnect.mutate(toRemove.id, {
      onSuccess: () => setToRemove(null),
      onError: (error) => {
        setToRemove(null);
        handleError(error, "Failed to disconnect the account");
      },
    });
  };

  const connectedSlugs = new Set(identities?.map((i) => i.provider.slug));
  const available = (providers ?? []).filter(
    (p) => !connectedSlugs.has(p.slug)
  );

  const columns: TableColumn<ConnectedIdentity>[] = [
    {
      title: "Provider",
      dataKey: "provider",
      cellElement: (i) => i.provider.displayName,
    },
    { title: "Email", dataKey: "email", cellElement: (i) => i.email ?? "—" },
    {
      title: "Last used",
      dataKey: "lastLoginAt",
      cellElement: (i) =>
        i.lastLoginAt ? new Date(i.lastLoginAt).toLocaleString() : "-",
    },
    {
      title: "Actions",
      align: "center",
      width: "8rem",
      cellElement: (i) => (
        <Button variant="secondary" size="sm" onClick={() => setToRemove(i)}>
          Disconnect
        </Button>
      ),
    },
  ];

  // Nothing to show or offer: keep the page as it was.
  if (!identities?.length && !available.length) return null;

  return (
    <Card>
      <SectionHeader title="Connected Accounts" />
      {identities?.length ? (
        <Table
          columns={columns}
          rows={identities}
          rowKey={(i) => i.id}
          hover={false}
        />
      ) : (
        <EmptyState>No accounts connected</EmptyState>
      )}
      {available.map((provider) => (
        <Button
          key={provider.slug}
          variant="secondary"
          size="sm"
          isLoading={connect.isPending && connect.variables === provider.slug}
          onClick={() => handleConnect(provider.slug)}
        >
          Connect {provider.displayName}
        </Button>
      ))}
      <ConfirmationModal
        show={!!toRemove}
        handleHide={() => setToRemove(null)}
        handleConfirm={handleDisconnect}
        title="Disconnect Account"
        body={`Disconnect ${toRemove?.provider.displayName} (${toRemove?.email ?? "—"}) from your account? You will no longer be able to sign in with it.`}
        confirmButtonText={
          disconnect.isPending ? "Disconnecting..." : "Disconnect"
        }
      />
    </Card>
  );
};
