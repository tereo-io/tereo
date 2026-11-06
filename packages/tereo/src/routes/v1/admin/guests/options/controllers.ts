import { prisma } from "../../../../../utils/db/prisma.js";
import type { Request, Response } from "express";
import env from "../../../../../env.js";
import {
  getGuestDefaultRoleIds,
  guestAssignableProblemsOf,
} from "../../../../../utils/guestRoles.js";

/**
 * What an inviter needs without roles.read: the custom roles a guest may be
 * given now, the defaults among them, and the longest expiry allowed.
 */
export const getGuestOptions = async (_req: Request, res: Response) => {
  const candidates = await prisma.role.findMany({
    where: {
      serviceId: null,
      guestAssignable: true,
      isActive: true,
      archivedAt: null,
      retiredAt: null,
    },
    select: {
      id: true,
      name: true,
      displayName: true,
      description: true,
      rolePermissions: {
        select: {
          permission: {
            select: { name: true, retiredAt: true, orgAssignable: true },
          },
        },
      },
    },
    orderBy: { name: "asc" },
  });
  const roles = candidates
    .filter(
      (r) =>
        guestAssignableProblemsOf(r.rolePermissions.map((rp) => rp.permission))
          .length === 0
    )
    .map(({ id, name, displayName, description }) => ({
      id,
      name,
      displayName,
      description,
    }));
  const assignable = new Set(roles.map((r) => r.id));
  const defaultRoleIds = (await getGuestDefaultRoleIds()).filter((id) =>
    assignable.has(id)
  );

  res.json({
    roles,
    defaultRoleIds,
    maxTtlSeconds: env.GUEST_MAX_TTL_SECONDS,
  });
};
