import { formatGroup } from "../../../../../utils/transformers.js";
import { validateBody } from "../../../../../utils/validateReq.js";
import { validateUser } from "../../../../../middleware/auth.js";
import { loadAuthorizedGroup } from "./middleware.js";
import db from "../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import { UpdateGroupSchema } from "./schemas.js";
import {
  afterGroupChange,
  archiveGroup as archiveGroupChange,
  restoreGroup as restoreGroupChange,
  updateGroup as updateGroupChange,
} from "../../../../../utils/groups.js";

const withMemberCount = async (group: Parameters<typeof formatGroup>[0]) =>
  formatGroup(
    group,
    (await db.groups.countMembers([group.id])).get(group.id) ?? 0,
    (await db.scimGroups.summariesForGroups([group.id])).get(group.id)
  );

export const getGroup = async (req: Request, res: Response) => {
  const { group } = await loadAuthorizedGroup(req, "read");
  res.json(await withMemberCount(group));
};

export const updateGroup = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { group, grantable, callerOrgRole } = await loadAuthorizedGroup(
    req,
    "write"
  );
  const body = validateBody(UpdateGroupSchema, req);

  const change = await db.$transaction((tx) =>
    updateGroupChange(
      { mode: "admin", auth, grantable, callerOrgRole },
      group.id,
      body,
      tx
    )
  );
  afterGroupChange(change);

  res.json(await withMemberCount(change.group));
};

export const archiveGroup = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { group, grantable, callerOrgRole } = await loadAuthorizedGroup(
    req,
    "archive"
  );

  const change = await db.$transaction(
    (tx) =>
      archiveGroupChange(
        { mode: "admin", auth, grantable, callerOrgRole },
        group.id,
        tx
      ),
    { timeout: 30_000 }
  );
  afterGroupChange(change);

  res.json(await withMemberCount(change.group));
};

export const restoreGroup = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const { group, grantable, callerOrgRole } = await loadAuthorizedGroup(
    req,
    "archive"
  );

  const change = await db.$transaction(
    (tx) =>
      restoreGroupChange(
        { mode: "admin", auth, grantable, callerOrgRole },
        group.id,
        tx
      ),
    { timeout: 30_000 }
  );
  afterGroupChange(change);

  res.json(await withMemberCount(change.group));
};
