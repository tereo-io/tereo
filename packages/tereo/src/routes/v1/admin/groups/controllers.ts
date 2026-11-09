import { validateBody, validateQuery } from "../../../../utils/validateReq.js";
import { formatGroup, formatGroups } from "../../../../utils/transformers.js";
import { hasPermission } from "../../../../utils/permissions.js";
import { validateUser } from "../../../../middleware/auth.js";
import { ForbiddenError } from "../../../../utils/errors.js";
import { authorizeGroup, requireGroupOrgAdmin } from "./group/middleware.js";
import { cursorId, nextCursor } from "./utils.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";
import {
  afterGroupChange,
  createGroup as createGroupChange,
} from "../../../../utils/groups.js";
import {
  CreateGroupSchema,
  CreateGroupScopeSchema,
  ListGroupsQuerySchema,
} from "./schemas.js";

/**
 * Lists groups. A caller without `groups.read` names one organization they
 * administer (or hold `organizations.write` over), and sees only its groups.
 */
export const listGroups = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const query = validateQuery(ListGroupsQuerySchema, req);
  if (!hasPermission(auth.permissions, "groups.read")) {
    if (!query.organizationId || query.organizationId === "global") {
      throw new ForbiddenError(
        "The following permission is required: groups.read"
      );
    }
    await requireGroupOrgAdmin(req, query.organizationId, "read");
  }

  const page = await db.groups.list({
    organizationId: query.organizationId,
    definitionSource: query.definitionSource,
    archived: query.archived,
    q: query.q,
    cursor: cursorId(query.cursor),
    limit: query.limit,
  });
  res.json({
    data: await formatGroups(page.data),
    hasMore: page.hasMore,
    limit: query.limit,
    nextCursor: nextCursor(page),
  });
};

export const createGroup = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { organizationId = null } = validateBody(CreateGroupScopeSchema, req);
  const { grantable, callerOrgRole } = await authorizeGroup(
    req,
    { organizationId },
    "write"
  );
  const body = validateBody(CreateGroupSchema, req);

  const change = await db.$transaction((tx) =>
    createGroupChange(
      { mode: "admin", auth, grantable, callerOrgRole },
      {
        organizationId,
        slug: body.slug,
        name: body.name,
        description: body.description ?? null,
        roleIds: body.roleIds,
      },
      tx
    )
  );
  afterGroupChange(change);

  res.status(201).json(formatGroup(change.group, 0));
};
