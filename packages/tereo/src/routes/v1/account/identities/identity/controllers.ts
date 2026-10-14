import { unlinkIdentity } from "../../../../../utils/identityProviders/identities.js";
import { validateParams } from "../../../../../utils/validateReq.js";
import { validateUser } from "../../../../../utils/auth.js";
import { IdentityParamsSchema } from "./schemas.js";
import type { Request, Response } from "express";

export const unlinkOwnIdentity = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id } = validateParams(IdentityParamsSchema, req);
  await unlinkIdentity(auth, auth.userId, id);
  res.status(204).send();
};
