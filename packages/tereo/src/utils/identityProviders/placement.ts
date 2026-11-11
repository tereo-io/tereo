import type { Prisma } from "../db/prisma.js";
import db from "../db/index.js";

type Tx = Prisma.TransactionClient;

export const organizationClosed = (org: {
  archivedAt: Date | null;
  isActive: boolean;
}): boolean => org.archivedAt !== null || !org.isActive;

/** Where a user provisioned through the domain goes: its organization and live default roles. */
export const domainPlacement = async (
  providerId: string,
  domainId: string,
  tx?: Tx
): Promise<{ organizationId: string; roleIds: string[] }> => {
  const domain = await db.identityProviders.getDomain(providerId, domainId, tx);
  // A default role archived or retired since it was chosen is not granted.
  const roles = await db.roles.getByIds(
    domain.roles.map((r) => r.role.id),
    tx
  );
  return {
    organizationId: domain.organizationId,
    roleIds: roles.map((r) => r.id),
  };
};
