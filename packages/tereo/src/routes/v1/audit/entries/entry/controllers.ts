import { validateParams } from "../../../../../utils/validateReq.js";
import db from "../../../../../utils/db/index.js";
import { entryParamsSchema } from "./schemas.js";
import { Request, Response } from "express";

export const getEntry = async (req: Request, res: Response) => {
  const params = validateParams(entryParamsSchema, req);
  const entry = await db.auditLogEntries.getById(
    params.id,
    req.auditOrganizationId
  );
  res.json(entry);
};
