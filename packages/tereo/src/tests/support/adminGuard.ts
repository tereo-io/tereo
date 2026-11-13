import { prisma, type Prisma } from "../../utils/db/prisma.js";

/**
 * Other suites leave administrators behind: sets aside every direct admin
 * assignment (expired) and every global group granting admin (archived), and
 * returns the function that puts them back.
 */
export const setAsideAdmins = async (): Promise<() => Promise<void>> => {
  const expired = new Map<string, Date | null>();
  const archivedGroups: string[] = [];
  const grantsAdmin = {
    isActive: true,
    archivedAt: null,
    retiredAt: null,
    rolePermissions: {
      some: { permission: { name: "admin", retiredAt: null } },
    },
  } satisfies Prisma.RoleWhereInput;
  const direct = await prisma.userRole.findMany({
    where: {
      organizationId: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      user: { isActive: true, userType: "human" },
      role: grantsAdmin,
    },
  });
  for (const a of direct) {
    expired.set(a.id, a.expiresAt);
    await prisma.userRole.update({
      where: { id: a.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
  }
  const groups = await prisma.group.findMany({
    where: {
      organizationId: null,
      archivedAt: null,
      roles: { some: { role: grantsAdmin } },
    },
  });
  for (const g of groups) {
    archivedGroups.push(g.id);
    await prisma.group.update({
      where: { id: g.id },
      data: { archivedAt: new Date() },
    });
  }
  return async () => {
    for (const [id, expiresAt] of expired) {
      await prisma.userRole.updateMany({ where: { id }, data: { expiresAt } });
    }
    await prisma.group.updateMany({
      where: { id: { in: archivedGroups } },
      data: { archivedAt: null },
    });
  };
};
