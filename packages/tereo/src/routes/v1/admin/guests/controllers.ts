import { validateBody, validateQuery } from "../../../../utils/validateReq.js";
import { InviteGuestSchema, ListGuestsQuerySchema } from "./schemas.js";
import { formatAdminUser } from "../../../../utils/transformers.js";
import { validateUser } from "../../../../utils/auth.js";
import { prisma } from "../../../../utils/db/prisma.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";
import {
  disconnectTokenSockets,
  notifyOrgRolesChanged,
} from "../../../../websocket/emitters/index.js";
import {
  inviteGuest as invite,
  visibleGuestsWhere,
} from "../../../../utils/guests.js";
import {
  applyCursorToWhere,
  buildCursorPageResponse,
} from "../../../../utils/cursor.js";

export const inviteGuest = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const body = validateBody(InviteGuestSchema, req);

  const result = await db.$transaction((tx) => invite(tx, auth, body));

  disconnectTokenSockets(result.revokedJtis);
  notifyOrgRolesChanged(result.user.id, result.organizationId);
  res.status(result.created ? 201 : 200).json({
    user: {
      ...formatAdminUser(result.user),
      organizationId: result.organizationId,
    },
    created: result.created,
    ...(result.passwordSetupUrl !== undefined && {
      passwordSetupUrl: result.passwordSetupUrl,
    }),
  });
};

export const listGuests = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const query = validateQuery(ListGuestsQuerySchema, req);

  const visible = await visibleGuestsWhere(auth);
  const where = applyCursorToWhere(query, {
    userType: "guest",
    ...(visible && { AND: [visible] }),
  });

  const result = await db.users.getPaginated({
    take: query.limit,
    orderBy: query.orderBy,
    where,
  });

  const page = buildCursorPageResponse(result, query);
  const memberships = await prisma.organizationMember.findMany({
    where: {
      userId: { in: page.data.map((u) => u.id) },
      organization: { archivedAt: null },
    },
    select: { userId: true, organizationId: true },
  });
  const orgOf = new Map(memberships.map((m) => [m.userId, m.organizationId]));
  res.json({
    ...page,
    data: page.data.map((u) => ({
      ...formatAdminUser(u),
      organizationId: orgOf.get(u.id) ?? null,
    })),
  });
};
