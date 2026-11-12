import { validateParams } from "../../../../../../../utils/validateReq.js";
import { releaseScimUser } from "../../../../../../../utils/scim/users.js";
import { validateUser } from "../../../../../../../utils/auth.js";
import { UserIdParamSchema } from "../../schemas.js";
import type { Request, Response } from "express";

export const releaseUser = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id } = validateParams(UserIdParamSchema, req);
  await releaseScimUser(auth, id);
  res.status(204).send();
};
