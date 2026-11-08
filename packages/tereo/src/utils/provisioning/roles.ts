import { CORE_SERVICE_ID } from "../../definitions/index.js";
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
