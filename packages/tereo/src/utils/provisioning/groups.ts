import type { ProvisioningSet, ResolvedService } from "./load.js";
import { roleTargetProblems } from "./roles.js";

const groupLabel = (file: string, slug: string) => `${file}: groups[${slug}]`;

/** A group's identity: its slug within its organization, or globally. */
export const groupScopeKey = (group: {
  slug: string;
  organizationId?: string | null;
}) =>
  group.organizationId ? `${group.organizationId}/${group.slug}` : group.slug;

/**
 * Each group's roles, against the set and core (`roleTargetProblems`): an
 * organization's group holds only org-assignable custom roles of the set.
 */
export const checkGroups = (
  set: ProvisioningSet,
  services: { service: ResolvedService }[],
  problems: string[]
): void => {
  const customRoles = new Map(
    set.documents.flatMap((d) => d.roles.map((r) => [r.name, r] as const))
  );
  for (const { file, groups } of set.documents)
    for (const group of groups ?? [])
      problems.push(
        ...roleTargetProblems({
          label: groupLabel(file, group.slug),
          roles: group.roles,
          organizationId: group.organizationId,
          customRoles,
          services,
          holders: "groups",
          orgHolder: "an organization's group",
        })
      );
};
