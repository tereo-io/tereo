import { AddMembersSchema, ListMembersQuerySchema } from "./schemas.js";
import { validateUser } from "../../../../../../middleware/auth.js";
import { loadAuthorizedGroup } from "../middleware.js";
import { cursorId, nextCursor } from "../../utils.js";
import db from "../../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateQuery,
} from "../../../../../../utils/validateReq.js";
import {
  afterGroupChange,
  addMembers as addMembersChange,
} from "../../../../../../utils/groups.js";

export const listMembers = async (req: Request, res: Response) => {
  const { group } = await loadAuthorizedGroup(req, "read");
  const query = validateQuery(ListMembersQuerySchema, req);

  const page = await db.groups.listMembers(group.id, {
    cursor: cursorId(query.cursor),
    limit: query.limit,
  });
  res.json({
    data: page.data.map((m) => ({
      userId: m.user.id,
      email: m.user.email,
      name: m.user.name,
      isActive: m.user.isActive,
      addedAt: m.createdAt,
    })),
    hasMore: page.hasMore,
    limit: query.limit,
    nextCursor: nextCursor(page),
  });
};

/**
 * Adds users to the group. Each must be a regular user and, for an
 * organization's group, a member of it; the caller must be able to grant
 * every role the group holds.
 */
export const addMembers = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { group, grantable, callerOrgRole } = await loadAuthorizedGroup(
    req,
    "write"
  );
  const { userIds } = validateBody(AddMembersSchema, req);

  const change = await db.$transaction(
    (tx) =>
      addMembersChange(
        { mode: "admin", auth, grantable, callerOrgRole },
        group.id,
        userIds,
        tx
      ),
    { timeout: 30_000 }
  );
  afterGroupChange(change);

  res.json({ added: change.added });
};
