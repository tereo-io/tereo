import useRevokeBrandingGrant from "../../api/branding/useRevokeBrandingGrant";
import useAddBrandingGrant from "../../api/branding/useAddBrandingGrant";
import { Button, EmptyState, Input, Spinner } from "@kosmeo-ui/react";
import useBrandingGrants from "../../api/branding/useBrandingGrants";
import type { UserListItem } from "@/features/auth-admin/types/user";
import UserTypeahead from "../users/UserTypeahead";
import { useAuth } from "@/lib/auth";
import { useState } from "react";

interface GrantsPanelProps {
  clientId: string;
  /** Lists the grants without Grant and Revoke. */
  readOnly?: boolean;
}

/** Who may edit this client's branding besides its owner and branding admins. */
export const GrantsPanel = ({
  clientId,
  readOnly = false,
}: GrantsPanelProps) => {
  const { hasPermission } = useAuth();
  const { data: grants, isLoading } = useBrandingGrants(clientId);
  const add = useAddBrandingGrant(clientId);
  const revoke = useRevokeBrandingGrant(clientId);
  // Searching users needs users.read; without it the id is entered directly.
  const canSearchUsers = hasPermission("users.read");
  const [selected, setSelected] = useState<UserListItem | null>(null);
  const [manualId, setManualId] = useState("");

  const userId = canSearchUsers ? selected?.id : manualId.trim();

  const grant = async () => {
    if (!userId) return;
    try {
      await add.mutateAsync(userId);
    } catch {
      return;
    }
    setSelected(null);
    setManualId("");
  };

  return (
    <section className="t-grants" aria-label="Who can edit">
      <h2>Who can edit</h2>
      {!readOnly && (
        <div className="t-grants-add">
          {canSearchUsers ? (
            <UserTypeahead value={selected} onSelect={setSelected} />
          ) : (
            <Input
              label="User ID"
              value={manualId}
              placeholder="User UUID"
              onChange={(e) => setManualId(e.target.value)}
            />
          )}
          <Button
            isLoading={add.isPending}
            disabled={!userId || add.isPending}
            onClick={grant}
          >
            Grant
          </Button>
        </div>
      )}
      {isLoading ? (
        <Spinner />
      ) : !grants?.length ? (
        <EmptyState layout="block">
          No one else can edit this branding
        </EmptyState>
      ) : (
        <ul>
          {grants.map((g) => (
            <li key={g.userId} className="t-grants-row">
              <span>
                {g.name ? `${g.name} ` : ""}
                <small>{g.email}</small>
              </span>
              {!readOnly && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={revoke.isPending}
                  aria-label={`Revoke ${g.email}`}
                  onClick={() => revoke.mutate(g.userId)}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
