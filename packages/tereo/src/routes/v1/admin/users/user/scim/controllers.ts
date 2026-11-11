import { validateParams } from "../../../../../../utils/validateReq.js";
import { unlinkScimUser } from "../../../../../../utils/scim/users.js";
import { validateUser } from "../../../../../../utils/auth.js";
import { UserIdParamSchema } from "../schemas.js";
import type { Request, Response } from "express";

export const unlinkUser = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id } = validateParams(UserIdParamSchema, req);
  await unlinkScimUser(auth, id);
  res.status(204).send();
};
