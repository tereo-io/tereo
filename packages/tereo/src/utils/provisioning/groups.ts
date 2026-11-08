import type { ProvisioningSet, ResolvedService } from "./load.js";
import { ROLES } from "../../definitions/roles.js";

const CORE_ROLES = new Map(ROLES.map((r) => [r.name, r.permissions]));

const groupLabel = (file: string, slug: string) => `${file}: groups[${slug}]`;

/** A group's identity: its slug within its organization, or globally. */
export const groupScopeKey = (group: {
  slug: string;
  organizationId?: string | null;
}) =>
  group.organizationId ? `${group.organizationId}/${group.slug}` : group.slug;

/**
 * Each group's roles, against the set and core. A bare name is the set's
 * custom role when declared, else core's; `<slug>/<name>` a service's system
 * role. An organization's group holds only org-assignable custom roles; no
 * group holds a role carrying `admin`.
 */
export const checkGroups = (
  set: ProvisioningSet,
  services: { service: ResolvedService }[],
  problems: string[]
): void => {
  const customRoles = new Map(
    set.documents.flatMap((d) => d.roles.map((r) => [r.name, r] as const))
  );
  // Undefined when the name resolves to no role.
  const systemRolePermissions = (target: string): string[] | undefined => {
    const slash = target.indexOf("/");
    if (slash === -1) return CORE_ROLES.get(target);
    const slug = target.slice(0, slash);
    const name = target.slice(slash + 1);
    return services
      .find((s) => s.service.slug === slug)
      ?.service.systemRoles.find((r) => r.name === name)?.permissions;
  };

  for (const { file, groups } of set.documents) {
    for (const group of groups ?? []) {
      for (const role of group.roles) {
        const where = `${groupLabel(file, group.slug)}: roles "${role}"`;
        const custom = customRoles.get(role);
        const system = custom ? undefined : systemRolePermissions(role);
        if ((custom?.permissions ?? system ?? []).includes("admin")) {
          problems.push(
            `${where} carries the admin permission; groups can't hold it`
          );
          continue;
        }
        if (group.organizationId) {
          if (custom?.orgAssignable) continue;
          problems.push(
            custom
              ? `${where} is not org-assignable; an organization's group holds only org-assignable custom roles`
              : system
                ? `${where} is a system role; an organization's group holds only org-assignable custom roles`
                : `${where} is not a custom role in the provisioning set`
          );
        } else if (!custom && !system) {
          problems.push(
            `${where} is not a custom role in the provisioning set, a core role, nor a service's system role`
          );
        }
      }
    }
  }
};
