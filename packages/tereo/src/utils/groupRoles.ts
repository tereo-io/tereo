import db from "./db/index.js";

export interface GroupRoleEntry {
  id: string;
  name: string;
  displayName: string;
  organizationId: string | null;
  via: { kind: "group"; groupId: string };
  group: { id: string; slug: string; name: string };
}

/**
 * Each live role a user holds through a live group, once per role and group.
 * `organizationId` null: the global groups; an id: that organization's groups
 * only (a global group's roles are not that organization's to show). A role
 * held through two groups appears in each.
 */
export const listGroupRoles = async (
  userId: string,
  organizationId: string | null
): Promise<GroupRoleEntry[]> => {
  const groups = new Map(
    (await db.groups.getUserGroups(userId, { organizationId }))
      .filter((g) => g.organizationId === organizationId)
      .map((g) => [g.id, { id: g.id, slug: g.slug, name: g.name }])
  );
  const entries = new Map<string, GroupRoleEntry>();
  for (const a of await db.roles.effectiveAssignments(userId, organizationId)) {
    if (a.via.kind !== "group") continue;
    const group = groups.get(a.via.groupId);
    if (!group) continue;
    entries.set(`${a.roleId}:${group.id}`, {
      id: a.role.id,
      name: a.role.name,
      displayName: a.role.displayName,
      organizationId: a.organizationId,
      via: { kind: "group", groupId: group.id },
      group,
    });
  }
  return [...entries.values()];
};
