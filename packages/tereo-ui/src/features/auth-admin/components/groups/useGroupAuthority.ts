import type { Group } from "../../api/groups/types";
import { useCallback, useMemo } from "react";
import { useAuth } from "@/lib/auth";

const isOrgAdmin = (o: { memberRole: string }) =>
  o.memberRole === "owner" || o.memberRole === "admin";

/**
 * Core lets an `admin` or `owner` of an organization (or
 * `organizations.write`) manage that organization's groups without the
 * `groups.*` permission; a global group needs it.
 */
export const useGroupAccess = () => {
  const { hasPermission, organizations } = useAuth();

  const orgAuthority = useCallback(
    (orgId: string | null | undefined) =>
      !!orgId &&
      (hasPermission("organizations.write") ||
        (organizations ?? []).some((o) => o.id === orgId && isOrgAdmin(o))),
    [hasPermission, organizations]
  );

  return useMemo(
    () => ({
      orgAuthority,
      /** Whether the viewer may open this group's page. */
      canRead: (group: Pick<Group, "organizationId">) =>
        hasPermission("groups.read") || orgAuthority(group.organizationId),
      /** Whether some group page may be open to the viewer. */
      canReadAny:
        hasPermission("groups.read") ||
        hasPermission("organizations.write") ||
        (organizations ?? []).some(isOrgAdmin),
    }),
    [hasPermission, organizations, orgAuthority]
  );
};

/** What the viewer may do to a group. */
export const useGroupAuthority = (
  group: Pick<Group, "organizationId"> | undefined
) => {
  const { hasPermission } = useAuth();
  const { orgAuthority } = useGroupAccess();
  const authority = orgAuthority(group?.organizationId);

  return {
    canWrite: hasPermission("groups.write") || authority,
    canArchive: hasPermission("groups.archive") || authority,
  };
};
