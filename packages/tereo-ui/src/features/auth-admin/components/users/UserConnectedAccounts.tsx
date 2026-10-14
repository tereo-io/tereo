import useIdentityProviders from "../../api/identity-providers/useIdentityProviders";
import type { ConnectedIdentity } from "../../api/identity-providers/types";
import useUserIdentityInvite from "../../api/users/useUserIdentityInvite";
import useUnlinkUserIdentity from "../../api/users/useUnlinkUserIdentity";
import useUserIdentities from "../../api/users/useUserIdentities";
import { useAuth } from "@/lib/auth";
import { useState } from "react";
import {
  Badge,
  BorderedSection,
  Button,
  Card,
  ConfirmationModal,
  EmptyState,
  Select,
  SectionHeader,
} from "@kosmeo-ui/react";

interface UserConnectedAccountsProps {
  userId: string;
  email: string;
}

/** The provider accounts a user signs in with, and invites still waiting. */
export const UserConnectedAccounts = ({
  userId,
  email,
}: UserConnectedAccountsProps) => {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission("users.write");
  // The identities route is part of core's users API; the provider list
  // that invites choose from needs identity-providers.read.
  const canPickProvider = canWrite && hasPermission("identity-providers.read");
  const { data } = useUserIdentities(userId);
  const { data: providers } = useIdentityProviders();
  const unlink = useUnlinkUserIdentity();
  const { invite, revoke } = useUserIdentityInvite();
  const [toUnlink, setToUnlink] = useState<ConnectedIdentity | null>(null);
  const [inviteProviderId, setInviteProviderId] = useState("");

  const connectedSlugs = new Set(data?.identities.map((i) => i.provider.slug));
  const invitedIds = new Set(data?.invites.map((i) => i.provider.id));
  const invitable = (providers ?? []).filter(
    (p) => p.isActive && !connectedSlugs.has(p.slug) && !invitedIds.has(p.id)
  );

  return (
    <Card>
      <SectionHeader title="Connected Accounts" />
      {data?.identities.length || data?.invites.length ? (
        <>
          {data.identities.map((identity) => (
            <BorderedSection key={identity.id}>
              <strong>{identity.provider.displayName}</strong>{" "}
              <span className="v-muted-text">{identity.email ?? "—"}</span>
              <div>
                Last used:{" "}
                {identity.lastLoginAt
                  ? new Date(identity.lastLoginAt).toLocaleString()
                  : "never"}
              </div>
              {canWrite && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setToUnlink(identity)}
                >
                  Disconnect
                </Button>
              )}
            </BorderedSection>
          ))}
          {data.invites.map((pending) => (
            <BorderedSection key={pending.provider.id}>
              <strong>{pending.provider.displayName}</strong>{" "}
              <Badge size="sm" subtle variant="warning">
                Invited
              </Badge>
              <div>Expires: {new Date(pending.expiresAt).toLocaleString()}</div>
              {canWrite && (
                <Button
                  variant="secondary"
                  size="sm"
                  isLoading={revoke.isPending}
                  onClick={() =>
                    revoke.mutate({ userId, providerId: pending.provider.id })
                  }
                >
                  Withdraw invite
                </Button>
              )}
            </BorderedSection>
          ))}
        </>
      ) : (
        <EmptyState>No connected accounts</EmptyState>
      )}
      {canPickProvider && invitable.length > 0 && (
        <>
          <Select
            label="Invite to a provider"
            placeholder="Select a provider"
            value={inviteProviderId}
            onChange={(value) => setInviteProviderId(value ?? "")}
            options={invitable.map((p) => ({
              value: p.id,
              label: p.displayName,
            }))}
          />
          <Button
            size="sm"
            disabled={!inviteProviderId}
            isLoading={invite.isPending}
            onClick={() =>
              invite.mutate(
                { userId, providerId: inviteProviderId },
                { onSuccess: () => setInviteProviderId("") }
              )
            }
          >
            Invite
          </Button>
        </>
      )}
      <ConfirmationModal
        show={!!toUnlink}
        handleHide={() => setToUnlink(null)}
        handleConfirm={() =>
          toUnlink &&
          unlink.mutate(
            { userId, identityId: toUnlink.id },
            { onSettled: () => setToUnlink(null) }
          )
        }
        title="Disconnect Account"
        body={`Disconnect ${toUnlink?.provider.displayName} (${toUnlink?.email ?? "—"}) from ${email}? They can no longer sign in with it.`}
        confirmButtonText={unlink.isPending ? "Disconnecting..." : "Disconnect"}
      />
    </Card>
  );
};
