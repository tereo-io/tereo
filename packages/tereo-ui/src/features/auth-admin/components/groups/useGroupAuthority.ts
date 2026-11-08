import type { Group } from "../../api/groups/types";
import { useAuth } from "@/lib/auth";

/**
 * What the viewer may do to a group. Core lets an `admin` or `owner` of an
 * organization (or `organizations.write`) manage that organization's
 * groups without the `groups.*` permission; a global group needs it.
 */
export const useGroupAuthority = (
  group: Pick<Group, "organizationId"> | undefined
) => {
  const { hasPermission, organizations } = useAuth();
  const orgId = group?.organizationId;
  const myRole = orgId
    ? organizations?.find((o) => o.id === orgId)?.memberRole
    : undefined;
  const orgAuthority =
    !!orgId &&
    (hasPermission("organizations.write") ||
      myRole === "owner" ||
      myRole === "admin");

  return {
    canWrite: hasPermission("groups.write") || orgAuthority,
    canArchive: hasPermission("groups.archive") || orgAuthority,
  };
};
