import { validateBody } from "../../../../../../utils/validateReq.js";
import { validateUser } from "../../../../../../middleware/auth.js";
import { loadAuthorizedGroup } from "../middleware.js";
import db from "../../../../../../utils/db/index.js";
import { SetGroupRolesSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  afterGroupChange,
  setGroupRoles as setGroupRolesChange,
} from "../../../../../../utils/groups.js";

/** Every role the group holds, archived, inactive or retired ones included. */
export const listGroupRoles = async (req: Request, res: Response) => {
  const { group } = await loadAuthorizedGroup(req, "read");
  res.json({ data: await db.groups.listRoles(group.id), nextCursor: null });
};

/**
 * Makes the group's roles exactly `roleIds`. The caller must be able to grant
 * each role added and take away each role removed.
 */
export const setGroupRoles = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { group, grantable, callerOrgRole } = await loadAuthorizedGroup(
    req,
    "write"
  );
  const { roleIds } = validateBody(SetGroupRolesSchema, req);

  const change = await db.$transaction(
    (tx) =>
      setGroupRolesChange(
        { mode: "admin", auth, grantable, callerOrgRole },
        group.id,
        roleIds,
        tx
      ),
    { timeout: 30_000 }
  );
  afterGroupChange(change);

  res.json({
    roles: await db.groups.listRoles(group.id),
    added: change.added,
    removed: change.removed,
  });
};
