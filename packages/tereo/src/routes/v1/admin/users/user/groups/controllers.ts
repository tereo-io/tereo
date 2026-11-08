import { formatGroups } from "../../../../../../utils/transformers.js";
import db from "../../../../../../utils/db/index.js";
import { UserGroupsQuerySchema } from "./schemas.js";
import { UserIdParamSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateParams,
  validateQuery,
} from "../../../../../../utils/validateReq.js";

/** Every group the user belongs to, global and in any organization. */
export const listUserGroups = async (req: Request, res: Response) => {
  const { id } = validateParams(UserIdParamSchema, req);
  const { includeArchived = false } = validateQuery(UserGroupsQuerySchema, req);
  await db.users.get(id);

  const groups = await db.groups.getUserGroups(id, { includeArchived });
  res.json({ data: await formatGroups(groups), nextCursor: null });
};
