import { validateParams } from "../../../../../utils/validateReq.js";
import { PermissionIdParamSchema } from "./schemas.js";
import db from "../../../../../utils/db/index.js";
import type { Request, Response } from "express";

export const getPermission = async (req: Request, res: Response) => {
  const params = validateParams(PermissionIdParamSchema, req);
  // Retired permissions stay viewable: custom roles may still list them.
  res.json(await db.permissions.get(params.id));
};
