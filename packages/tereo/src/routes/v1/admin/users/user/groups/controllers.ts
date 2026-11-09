import { formatGroups } from "../../../../../../utils/transformers.js";
import db from "../../../../../../utils/db/index.js";
import { UserGroupsQuerySchema } from "./schemas.js";
import { UserIdParamSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateParams,
  validateQuery,
} from "../../../../../../utils/validateReq.js";

/**
 * Every group the user belongs to, global and in any organization, each with
 * its organization's id and name (null for a global group).
 */
export const listUserGroups = async (req: Request, res: Response) => {
  const { id } = validateParams(UserIdParamSchema, req);
  const { includeArchived = false } = validateQuery(UserGroupsQuerySchema, req);
  await db.users.get(id);

  const groups = await db.groups.getUserGroups(id, { includeArchived });
  const names = await db.organizations.getNames(
    groups.flatMap((g) => (g.organizationId ? [g.organizationId] : []))
  );
  const data = (await formatGroups(groups)).map((g) => ({
    ...g,
    organization: g.organizationId
      ? { id: g.organizationId, name: names.get(g.organizationId) ?? "" }
      : null,
  }));
  res.json({ data, nextCursor: null });
};
