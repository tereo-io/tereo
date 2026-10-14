import { validateParams } from "../../../../../../utils/validateReq.js";
import { RoleIdParamSchema } from "../../schemas.js";
import db from "../../../../../../utils/db/index.js";
import type { Request, Response } from "express";

export const getRoleUsers = async (req: Request, res: Response) => {
  const params = validateParams(RoleIdParamSchema, req);

  // getAny: assignments survive archive, so the read-only user list must
  // stay visible for archived roles.
  await db.roles.getAny(params.id);
  const users = await db.roles.getUsersByRoleId(params.id);

  res.json({ roleId: params.id, users });
};
