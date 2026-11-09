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

export interface OrgGroupRoleEntry extends GroupRoleEntry {
  organizationId: string;
  organization: { id: string; name: string };
}

/**
 * Each live role a user holds through a live group of any organization, as
 * `listGroupRoles` reads it for each organization in turn (so only while the
 * user is a member there), with the organization's name.
 */
export const listOrgGroupRoles = async (
  userId: string
): Promise<OrgGroupRoleEntry[]> => {
  const orgIds = [
    ...new Set(
      (await db.groups.getUserGroups(userId))
        .map((g) => g.organizationId)
        .filter((id): id is string => id !== null)
    ),
  ].sort();
  const names = await db.organizations.getNames(orgIds);
  const perOrg = await Promise.all(
    orgIds.map((orgId) => listGroupRoles(userId, orgId))
  );
  return perOrg.flatMap((entries, i) => {
    const id = orgIds[i];
    return entries.map((e) => ({
      ...e,
      organizationId: id,
      organization: { id, name: names.get(id) ?? "" },
    }));
  });
};
