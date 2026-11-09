import { validateParams } from "../../../../../../../utils/validateReq.js";
import { validateUser } from "../../../../../../../middleware/auth.js";
import { NotFoundError } from "../../../../../../../utils/errors.js";
import { loadAuthorizedGroup } from "../../middleware.js";
import db from "../../../../../../../utils/db/index.js";
import { MemberUserIdParamSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  afterGroupChange,
  removeMembers,
} from "../../../../../../../utils/groups.js";

export const removeMember = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { group, grantable, callerOrgRole } = await loadAuthorizedGroup(
    req,
    "write"
  );
  const { userId } = validateParams(MemberUserIdParamSchema, req);

  const change = await db.$transaction(
    async (tx) => {
      const result = await removeMembers(
        { mode: "admin", auth, grantable, callerOrgRole },
        group.id,
        [userId],
        tx
      );
      if (result.removed.length === 0) {
        throw new NotFoundError("User is not a member of this group");
      }
      return result;
    },
    { timeout: 30_000 }
  );
  afterGroupChange(change);

  res.status(204).send();
};
