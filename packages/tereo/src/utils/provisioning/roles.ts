import { CORE_SERVICE_ID } from "../../definitions/index.js";
import { ROLES } from "../../definitions/roles.js";
import type { CustomRoleEntry } from "./schema.js";
import type { ResolvedService } from "./load.js";
import type { Prisma } from "../db/prisma.js";

/**
 * The role a provisioned integration or group names: `<slug>/<name>` a
 * service's system role; a bare name the set's custom role when the set
 * declares one, else core's (never a custom role an admin made). Validation
 * checked the names against the set; the database is checked here.
 */
export const resolveProvisionedRole = async (
  tx: Prisma.TransactionClient,
  target: string,
  setRoleNames: Set<string>
) => {
  const slash = target.indexOf("/");
  const live = { archivedAt: null, retiredAt: null };
  if (slash !== -1) {
    return tx.role.findFirst({
      where: {
        name: target.slice(slash + 1),
        service: { slug: target.slice(0, slash), kind: "service" },
        ...live,
      },
      select: { id: true },
    });
  }
  return tx.role.findFirst({
    where: setRoleNames.has(target)
      ? { name: target, serviceId: null, provisioned: true, ...live }
      : { name: target, serviceId: CORE_SERVICE_ID, ...live },
    select: { id: true },
  });
};

const CORE_ROLES = new Map(ROLES.map((r) => [r.name, r.permissions]));

/**
 * Problems with the roles an integration or a group names, against the set
 * and core: a bare name is the set's custom role when declared, else core's;
 * `<slug>/<name>` a service's system role. Org-bound, only org-assignable
 * custom roles of the set; never a role carrying `admin`. Each problem starts
 * with `${label}: roles "<name>"`.
 */
export const roleTargetProblems = ({
  label,
  roles,
  organizationId,
  customRoles,
  services,
  holders,
  orgHolder,
}: {
  label: string;
  roles: string[];
  organizationId: string | null | undefined;
  customRoles: Map<
    string,
    Pick<CustomRoleEntry, "orgAssignable" | "permissions">
  >;
  services: { service: ResolvedService }[];
  /** Who can't hold `admin`, plural: "integrations". */
  holders: string;
  /** Who holds only org-assignable custom roles: "an org-bound integration". */
  orgHolder: string;
}): string[] => {
  // Undefined when the name resolves to no system role.
  const systemRolePermissions = (target: string): string[] | undefined => {
    const slash = target.indexOf("/");
    if (slash === -1) return CORE_ROLES.get(target);
    const slug = target.slice(0, slash);
    const name = target.slice(slash + 1);
    return services
      .find((s) => s.service.slug === slug)
      ?.service.systemRoles.find((r) => r.name === name)?.permissions;
  };
  const problems: string[] = [];
  for (const role of roles) {
    const where = `${label}: roles "${role}"`;
    const custom = customRoles.get(role);
    const system = custom ? undefined : systemRolePermissions(role);
    if ((custom?.permissions ?? system ?? []).includes("admin")) {
      problems.push(
        `${where} carries the admin permission; ${holders} can't hold it`
      );
      continue;
    }
    if (organizationId) {
      if (custom?.orgAssignable) continue;
      problems.push(
        custom
          ? `${where} is not org-assignable; ${orgHolder} holds only org-assignable custom roles`
          : system
            ? `${where} is a system role; ${orgHolder} holds only org-assignable custom roles`
            : `${where} is not a custom role in the provisioning set`
      );
    } else if (!custom && !system) {
      problems.push(
        `${where} is not a custom role in the provisioning set, a core role, nor a service's system role`
      );
    }
  }
  return problems;
};
