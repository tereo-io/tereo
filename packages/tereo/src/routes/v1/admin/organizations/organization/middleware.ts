import { guardArchivedById } from "../../../../../utils/guardArchived.js";
import { validateParams } from "../../../../../utils/validateReq.js";
import { requireOrgRole } from "../../../../../utils/orgRoleAuth.js";
import type { NextFunction, Request, Response } from "express";
import db from "../../../../../utils/db/index.js";
import { OrgIdParamSchema } from "../schemas.js";

// Weakest tier this router serves (org member OR organizations.read),
// checked before the archived guard so unauthorized callers get a uniform 403
// and can't use 403-vs-archived to probe archive state. Routes still apply
// their own, stricter checks.
export const requireOrgMember = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  try {
    const params = validateParams(OrgIdParamSchema, req);
    await requireOrgRole("member", req, params.id);
    next();
  } catch (err) {
    next(err);
  }
};

// Archived organizations are read-only: allow GET, hard DELETE, and restore;
// every other method (PATCH, member mutations) 409s. A missing id makes getAny
// throw NotFoundError, which the guard forwards as the 404.
export const guardArchivedOrganization = guardArchivedById((id) =>
  db.organizations.getAny(id)
);
