import { formatDateTime } from "@/utils/formatDate";
import type { ServiceAccess } from "../api/types";

/** When an access row was decided and by whom; a dash while pending. */
export const AccessDecision = ({ access }: { access: ServiceAccess }) => {
  if (!access.decidedAt) return <span className="v-muted-text">—</span>;
  const who =
    access.decidedByName ?? access.decidedByEmail ?? access.decidedBy ?? null;
  return (
    <span title={access.decidedByEmail ?? undefined}>
      {formatDateTime(access.decidedAt)}
      {who && <span className="v-muted-text"> by {who}</span>}
    </span>
  );
};
