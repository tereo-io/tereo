import type { OrgMemberRole } from "../../../prisma/generated/client/index.js";
import { globalGrantablePermissions } from "../../utils/grants.js";
import { ensurePermission, TEST_SERVICE } from "./testService.js";
import type { AuthContext } from "../../middleware/auth.js";
import type { GroupActor } from "../../utils/groups.js";
import { getTestPrincipalToken } from "./principals.js";
import { prisma } from "../../utils/db/prisma.js";
import { createTestRole } from "./auth/users.js";
import { randomUUID } from "node:crypto";

/** An org-assignable permission the group tests grant through roles. */
export const GROUP_PERMISSION = `${TEST_SERVICE.namespace}.group-service.read`;

export const PROVISIONING: GroupActor = { mode: "provisioning" };

/**
 * An admin-mode actor: a real user holding `permissions` through a global
 * role, with what they may grant read as the admin routes will.
 */
export const adminActor = async (
  permissions: string[],
  callerOrgRole: OrgMemberRole | null = null
): Promise<Extract<GroupActor, { mode: "admin" }>> => {
  const userId = randomUUID();
  await getTestPrincipalToken({ userId, permissions });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const auth: AuthContext = {
    userId,
    email: user.email,
    name: user.name,
    userType: user.userType,
    permissions,
    currentSessionId: null,
    rateLimitPerSecond: null,
    jti: randomUUID(),
    clientId: "test-client",
    oauthClientId: null,
    organizationId: null,
    authTime: null,
  };
  return {
    mode: "admin",
    auth,
    grantable: await globalGrantablePermissions(auth),
    callerOrgRole,
  };
};

export const ensureGroupPermission = async () => {
  await ensurePermission(GROUP_PERMISSION);
  await prisma.permission.update({
    where: { name: GROUP_PERMISSION },
    data: { orgAssignable: true },
  });
};

/** A custom role granting `permissionNames` (GROUP_PERMISSION by default). */
export const roleGranting = async (
  permissionNames: string[] = [GROUP_PERMISSION],
  data: { requires2fa?: boolean } = {}
) => {
  const role = await createTestRole();
  for (const name of permissionNames) {
    const permission = await ensurePermission(name);
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });
  }
  if (data.requires2fa) {
    await prisma.role.update({
      where: { id: role.id },
      data: { requires2fa: true },
    });
  }
  return role;
};

export const groupSlug = (label: string) =>
  `${label}-${randomUUID().slice(0, 8)}`;

/** Groups are never deleted by core; tests delete the ones they made. */
export const deleteGroups = async (groupIds: string[]) => {
  await prisma.groupMember.deleteMany({ where: { groupId: { in: groupIds } } });
  await prisma.groupRole.deleteMany({ where: { groupId: { in: groupIds } } });
  await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
};

export const joinOrg = (
  organizationId: string,
  userId: string,
  memberRole: OrgMemberRole = "member"
) =>
  prisma.organizationMember.create({
    data: { organizationId, userId, memberRole },
  });

/** A live access token from a password-only login (no auth code). */
export const passwordOnlyToken = async (userId: string) => {
  const client = await prisma.oAuthClient.findFirstOrThrow({
    select: { id: true },
  });
  const jti = randomUUID();
  await prisma.accessToken.create({
    data: {
      jti,
      clientId: client.id,
      userId,
      scopes: ["openid"],
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  return jti;
};
