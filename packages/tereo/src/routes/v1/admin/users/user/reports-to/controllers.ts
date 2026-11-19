import { validateUser } from "../../../../../../utils/auth.js";
import { SetReportsToSchema } from "./schemas.js";
import { UserIdParamSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";
import {
  clearReportsTo,
  setReportsTo,
} from "../../../../../../utils/reportsTo.js";

export const putReportsTo = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id } = validateParams(UserIdParamSchema, req);
  const { userId } = validateBody(SetReportsToSchema, req);
  res.json(await setReportsTo(auth, id, userId));
};

export const deleteReportsTo = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { id } = validateParams(UserIdParamSchema, req);
  await clearReportsTo(auth, id);
  res.status(204).end();
};
