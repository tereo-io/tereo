import useDeleteScimConnection from "../../api/identity-providers/useDeleteScimConnection";
import useSetScimConnection from "../../api/identity-providers/useSetScimConnection";
import useCreateScimToken from "../../api/identity-providers/useCreateScimToken";
import useRevokeScimToken from "../../api/identity-providers/useRevokeScimToken";
import useScimConnection from "../../api/identity-providers/useScimConnection";
import useAllOrganizations from "../../api/organizations/useAllOrganizations";
import ScimTokenModal from "./modals/ScimTokenModal";
import { formatDateTime } from "@/utils/formatDate";
import { useAuth } from "@/lib/auth";
import { useState } from "react";
import "./styles.css";
import type {
  ScimConnection,
  ScimGroupsTarget,
  ScimToken,
} from "../../api/identity-providers/types";
import {
  Badge,
  Button,
  Card,
  ConfirmationModal,
  DetailField,
  SecretDisplay,
  SectionHeader,
  Select,
  Spinner,
  Table,
  type TableColumn,
} from "@kosmeo-ui/react";

interface ScimPanelProps {
  providerId: string;
}

const MAX_LIVE_TOKENS = 2;

type TargetKind = ScimGroupsTarget["kind"];

const TARGET_OPTIONS: { value: TargetKind; label: string }[] = [
  { value: "none", label: "Off" },
  { value: "global", label: "Global groups" },
  { value: "organization", label: "An organization's groups" },
];

interface GroupsTargetFieldProps {
  providerId: string;
  connection: ScimConnection;
  /** Changing the target needs `admin` through a global role. */
  disabled: boolean;
}

const GroupsTargetField = ({
  providerId,
  connection,
  disabled,
}: GroupsTargetFieldProps) => {
  const setConnection = useSetScimConnection();
  // "An organization's groups" is chosen before an organization is, so the
  // choice is kept here until the picker saves it.
  const [pendingOrganization, setPendingOrganization] = useState(false);
  const stored = connection.groupsTarget;
  const kind: TargetKind = pendingOrganization ? "organization" : stored.kind;
  const { data: organizations } = useAllOrganizations({
    enabled: kind === "organization",
  });

  const save = (groupsTarget: ScimGroupsTarget) =>
    setConnection.mutate(
      { providerId, groupsTarget },
      { onSettled: () => setPendingOrganization(false) }
    );

  return (
    <>
      <Select<TargetKind>
        label="Groups"
        value={kind}
        options={TARGET_OPTIONS}
        disabled={disabled || setConnection.isPending}
        onChange={(value) => {
          if (value === "organization") {
            setPendingOrganization(true);
          } else if (value === "global" || value === "none") {
            setPendingOrganization(false);
            save({ kind: value });
          }
        }}
      />
      {kind === "organization" && (
        <Select
          label="Organization"
          placeholder="Choose an organization"
          value={stored.kind === "organization" ? stored.organizationId : ""}
          options={(organizations ?? []).map((o) => ({
            value: o.id,
            label: o.name,
          }))}
          disabled={disabled || setConnection.isPending}
          onChange={(organizationId) =>
            organizationId && save({ kind: "organization", organizationId })
          }
        />
      )}
    </>
  );
};

/** The provider's SCIM connection: enabling it, its base URL and its tokens. */
export const ScimPanel = ({ providerId }: ScimPanelProps) => {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission("identity-providers.write");
  const isGlobalAdmin = hasPermission("admin");
  const {
    data: connection,
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useScimConnection(providerId);
  const setConnection = useSetScimConnection();
  const deleteConnection = useDeleteScimConnection();
  const createToken = useCreateScimToken();
  const revokeToken = useRevokeScimToken();
  const [newToken, setNewToken] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ScimToken | null>(null);
  const [removing, setRemoving] = useState(false);

  if (isLoading) {
    return (
      <Card>
        <SectionHeader title="SCIM" />
        <Spinner size="md" />
      </Card>
    );
  }

  // Only a 404 is "no connection" (null). Any other failure says nothing
  // about the connection, and Enable could resume one an admin paused.
  if (isError || connection === undefined) {
    return (
      <Card>
        <SectionHeader title="SCIM" />
        <p>The SCIM connection could not be loaded.</p>
        <Button
          variant="secondary"
          size="sm"
          isLoading={isFetching}
          onClick={() => void refetch()}
        >
          Retry
        </Button>
      </Card>
    );
  }

  if (connection === null) {
    return (
      <Card>
        <SectionHeader
          title="SCIM"
          subtitle="Let the provider manage users here."
        />
        <p>
          Enabling SCIM lets this provider create, change and deactivate users
          in its domains, and sign in as them.
        </p>
        {canWrite && (
          <Button
            size="sm"
            isLoading={setConnection.isPending}
            onClick={() => setConnection.mutate({ providerId, isActive: true })}
          >
            Enable SCIM
          </Button>
        )}
      </Card>
    );
  }

  const liveTokens = connection.tokens.filter((t) => t.revokedAt === null);
  const atTokenLimit = liveTokens.length >= MAX_LIVE_TOKENS;
  const hasManagedUsers = connection.managedUserCount > 0;

  const columns: TableColumn<ScimToken>[] = [
    {
      title: "Created",
      dataKey: "createdAt",
      cellElement: (t) => formatDateTime(t.createdAt),
    },
    {
      title: "Last used",
      dataKey: "lastUsedAt",
      cellElement: (t) =>
        t.lastUsedAt ? formatDateTime(t.lastUsedAt) : "never",
    },
    {
      title: "Status",
      dataKey: "revokedAt",
      cellElement: (t) =>
        t.revokedAt ? (
          <Badge size="sm" subtle variant="danger">
            Revoked
          </Badge>
        ) : (
          <Badge size="sm" subtle variant="success">
            Live
          </Badge>
        ),
    },
    {
      title: "Actions",
      hidden: !canWrite,
      width: "7rem",
      align: "center",
      cellElement: (t) =>
        t.revokedAt ? null : (
          <Button variant="danger" size="sm" onClick={() => setRevoking(t)}>
            Revoke
          </Button>
        ),
    },
  ];

  return (
    <Card>
      <SectionHeader
        title="SCIM"
        subtitle="Let the provider manage users here."
        actions={
          <Badge
            size="sm"
            subtle
            variant={connection.isActive ? "success" : "danger"}
          >
            {connection.isActive ? "Enabled" : "Disabled"}
          </Badge>
        }
      />
      <DetailField
        label="Base URL"
        value={<SecretDisplay value={connection.baseUrl} />}
      />
      <DetailField label="Managed users" value={connection.managedUserCount} />
      <GroupsTargetField
        // Remount on a stored change so a finished save drops the local choice.
        key={JSON.stringify(connection.groupsTarget)}
        providerId={providerId}
        connection={connection}
        disabled={!canWrite || !isGlobalAdmin}
      />
      <DetailField
        label="Managed groups"
        value={connection.managedGroupCount}
      />
      <DetailField
        label="Last used"
        value={
          connection.lastUsedAt
            ? formatDateTime(connection.lastUsedAt)
            : "never"
        }
      />
      <Table
        columns={columns}
        rows={connection.tokens}
        rowKey={(t) => t.id}
        hover={false}
        emptyMessage="No tokens. Generate one and give it to the provider."
      />
      {canWrite && (
        <div className="t-idp-domains-action">
          <Button
            size="sm"
            disabled={atTokenLimit}
            isLoading={createToken.isPending}
            onClick={() =>
              createToken.mutate(providerId, {
                onSuccess: (created) => setNewToken(created.token),
              })
            }
          >
            Generate token
          </Button>
          {atTokenLimit && (
            <p className="v-muted-text">
              Two live tokens already exist. Revoke one to generate another.
            </p>
          )}
          <Button
            variant="secondary"
            size="sm"
            isLoading={setConnection.isPending}
            onClick={() =>
              setConnection.mutate({
                providerId,
                isActive: !connection.isActive,
              })
            }
          >
            {connection.isActive ? "Disable SCIM" : "Enable SCIM"}
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={hasManagedUsers}
            onClick={() => setRemoving(true)}
          >
            Remove SCIM
          </Button>
          {hasManagedUsers && (
            <p className="v-muted-text">
              SCIM still manages {connection.managedUserCount} user
              {connection.managedUserCount === 1 ? "" : "s"}. Unlink its users
              first.
            </p>
          )}
        </div>
      )}
      <ScimTokenModal
        token={newToken}
        onClose={() => {
          setNewToken(null);
          createToken.reset();
        }}
      />
      <ConfirmationModal
        show={!!revoking}
        handleHide={() => setRevoking(null)}
        handleConfirm={() =>
          revoking &&
          revokeToken.mutate(
            { providerId, tokenId: revoking.id },
            { onSettled: () => setRevoking(null) }
          )
        }
        title="Revoke Token"
        body="Revoke this token? The provider can no longer use it to reach SCIM."
        confirmButtonText="Revoke token"
      />
      <ConfirmationModal
        show={removing}
        handleHide={() => setRemoving(false)}
        handleConfirm={() =>
          deleteConnection.mutate(providerId, {
            onSettled: () => setRemoving(false),
          })
        }
        title="Remove SCIM"
        body="Remove the SCIM connection? Its tokens stop working."
        confirmButtonText="Remove connection"
      />
    </Card>
  );
};
