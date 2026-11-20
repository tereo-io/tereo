import { formatUserReport } from "../../../../../../utils/transformers.js";
import { listReports } from "../../../../../../utils/reportsTo.js";
import { UserReportsQuerySchema } from "./schemas.js";
import db from "../../../../../../utils/db/index.js";
import { UserIdParamSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateParams,
  validateQuery,
} from "../../../../../../utils/validateReq.js";

/** Who reports to the user: directly, or at every level below. */
export const listUserReports = async (req: Request, res: Response) => {
  const { id } = validateParams(UserIdParamSchema, req);
  const { transitive = false } = validateQuery(UserReportsQuerySchema, req);
  await db.users.get(id);

  const rows = await listReports(id, { transitive });
  res.json({ data: rows.map(formatUserReport), nextCursor: null });
};
