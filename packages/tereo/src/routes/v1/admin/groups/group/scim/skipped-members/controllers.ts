import { validateQuery } from "../../../../../../../utils/validateReq.js";
import { NotFoundError } from "../../../../../../../utils/errors.js";
import { ListSkippedMembersQuerySchema } from "./schemas.js";
import { loadAuthorizedGroup } from "../../middleware.js";
import db from "../../../../../../../utils/db/index.js";
import type { Request, Response } from "express";

/** Users the directory put in the group whom core could not add. */
export const listSkippedMembers = async (req: Request, res: Response) => {
  const { group } = await loadAuthorizedGroup(req, "read");
  const query = validateQuery(ListSkippedMembersQuerySchema, req);
  const link = await db.scimGroups.getLinkByGroup(group.id);
  if (!link) throw new NotFoundError("Group is not managed by SCIM");

  const page = await db.scimGroups.listSkipped(link.id, query);
  res.json({ ...page, limit: query.limit });
};
