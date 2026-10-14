import type { ServiceAccess } from "../api/types";

/**
 * The requested role or audience, and for another service's role awaiting
 * approval, the permissions approving it would grant: all of them on a first
 * request, only what the role gained on one approved before.
 */
export const AccessTarget = ({ access }: { access: ServiceAccess }) => (
  <>
    <span className="v-mono">{access.target}</span>
    {access.pendingPermissions && access.pendingPermissions.length > 0 && (
      <div className="v-muted-text">
        {access.decidedAt ? "Adds " : "Grants "}
        <span className="v-mono">{access.pendingPermissions.join(", ")}</span>
      </div>
    )}
  </>
);
