import type { OrgMemberRole } from "../../../../../../prisma/generated/client/index.js";
import { callerPermissionsIn } from "../../../../../utils/orgRoleAssignment.js";
import { ForbiddenError, NotFoundError } from "../../../../../utils/errors.js";
import { globalGrantablePermissions } from "../../../../../utils/grants.js";
import { requireOrgRole } from "../../../../../utils/orgRoleAuth.js";
import { validateParams } from "../../../../../utils/validateReq.js";
import { hasPermission } from "../../../../../utils/permissions.js";
import { validateUser } from "../../../../../middleware/auth.js";
import db from "../../../../../utils/db/index.js";
import { GroupIdParamSchema } from "./schemas.js";
import type { Request } from "express";

export type GroupNeed = "read" | "write" | "archive";

export interface GroupAuthority {
  /** What the caller may grant in the group's scope. */
  grantable: string[];
  /** The caller's membership role in the group's org, when they act as one. */
  callerOrgRole: OrgMemberRole | null;
}

const permissionRequired = (permission: string) =>
  new ForbiddenError(`The following permission is required: ${permission}`);

/**
 * Who may act on a group: a holder of `groups.<need>`, or, for an
 * organization's group, an admin or owner of that organization (for reading
 * too, since a group's members are the org's membership). A global group
 * needs the platform permission.
 */
export const authorizeGroup = async (
  req: Request,
  group: { organizationId: string | null },
  need: GroupNeed
): Promise<GroupAuthority> => {
  const auth = validateUser(req);
  const permission = `groups.${need}`;
  if (hasPermission(auth.permissions, permission)) {
    return {
      grantable: group.organizationId
        ? await callerPermissionsIn(auth, group.organizationId)
        : await globalGrantablePermissions(auth),
      callerOrgRole: null,
    };
  }
  if (!group.organizationId) throw permissionRequired(permission);
  const callerOrgRole = await requireOrgRole(
    "admin",
    req,
    group.organizationId
  );
  return {
    grantable: await callerPermissionsIn(auth, group.organizationId),
    callerOrgRole,
  };
};

/**
 * The group `:id` names, archived or not, once the caller may act on it. A
 * caller without `groups.<need>` gets 403 for a missing group as for one
 * outside their organizations, so ids cannot be probed.
 */
export const loadAuthorizedGroup = async (req: Request, need: GroupNeed) => {
  const auth = validateUser(req);
  const { id } = validateParams(GroupIdParamSchema, req);
  const permission = `groups.${need}`;
  const group = await db.groups.getAny(id).catch((err: unknown) => {
    if (
      err instanceof NotFoundError &&
      !hasPermission(auth.permissions, permission)
    ) {
      throw permissionRequired(permission);
    }
    throw err;
  });
  return { group, ...(await authorizeGroup(req, group, need)) };
};
