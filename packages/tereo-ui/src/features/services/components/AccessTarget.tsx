import type { ServiceAccess } from "../api/types";

/** The role or audience, and for another service's role the permissions its approval recorded. */
export const AccessTarget = ({ access }: { access: ServiceAccess }) => (
  <>
    <span className="v-mono">{access.target}</span>
    {access.approvedPermissions && access.approvedPermissions.length > 0 && (
      <div className="v-muted-text">
        Grants{" "}
        <span className="v-mono">{access.approvedPermissions.join(", ")}</span>
      </div>
    )}
  </>
);
