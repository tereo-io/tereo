import { PERMISSIONS } from "../../../../definitions/permissions.js";
import { validateQuery } from "../../../../utils/validateReq.js";
import { hasPermission } from "../../../../utils/permissions.js";
import { validateUser } from "../../../../middleware/auth.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";
import {
  applyCursorToWhere,
  buildCursorPageResponse,
} from "../../../../utils/cursor.js";
import {
  AccountOrganizationsSearchSchema,
  ListAccountOrganizationsQuerySchema,
} from "./schemas.js";

/**
 * The caller's active memberships; with `search`, those that match — or, for
 * a holder of `organizations.support-access` through this token, every active
 * organization that matches.
 */
export const listAccountOrganizations = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const query = validateQuery(ListAccountOrganizationsQuerySchema, req);
  const { search } = validateQuery(AccountOrganizationsSearchSchema, req);

  const supportSearch =
    search !== undefined &&
    hasPermission(auth.permissions, PERMISSIONS.ORGANIZATIONS.SUPPORT_ACCESS);

  const result = await db.organizations.searchActive({
    userId: auth.userId,
    membersOnly: !supportSearch,
    search,
    take: query.limit,
    orderBy: query.orderBy,
    where: applyCursorToWhere(query),
  });

  const page = buildCursorPageResponse(result, query);
  res.json({
    ...page,
    data: page.data.map(({ id, name, slug, memberRole }) => ({
      id,
      name,
      slug,
      memberRole,
      member: memberRole !== null,
    })),
  });
};
