import { validateParams } from "../../../../../utils/validateReq.js";
import type { NextFunction, Request, Response } from "express";
import { IdentityProviderIdParamSchema } from "./schemas.js";
import db from "../../../../../utils/db/index.js";

// A missing provider is a 404 for everything beneath it; routes apply their
// own permission before this (the router mounts it after the check).
export const requireProvider = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  try {
    const { id } = validateParams(IdentityProviderIdParamSchema, req);
    await db.identityProviders.get(id);
    next();
  } catch (err) {
    next(err);
  }
};
