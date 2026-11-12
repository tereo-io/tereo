import { unlinkScimGroupTx } from "../../../../../../utils/scim/groups.js";
import { validateUser } from "../../../../../../middleware/auth.js";
import { loadAuthorizedGroup } from "../middleware.js";
import db from "../../../../../../utils/db/index.js";
import type { Request, Response } from "express";

/**
 * Hands a pushed group back to local management. The link is read again
 * under the group lock: a SCIM delete or a connection delete that committed
 * while this request waited leaves it gone, which is the 404.
 */
export const unlinkGroup = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { group } = await loadAuthorizedGroup(req, "write");

  await db.$transaction(async (tx) => {
    await db.groups.lockGroup(group.id, tx);
    await unlinkScimGroupTx(tx, auth, group.id, "admin");
  });

  res.status(204).send();
};
