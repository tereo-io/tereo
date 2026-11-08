// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../../../../../../../utils/defaultOrganization.js";
import { getTestPrincipalToken } from "../../../../../../../support/principals.js";
import { HTTP_STATUS } from "../../../../../../../support/auth/constants.js";
import { createTestUser } from "../../../../../../../support/auth/users.js";
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import db from "../../../../../../../../utils/db/index.js";
import {
  adminApi,
  deleteGroups,
  ensureGroupPermission,
  GROUP_PERMISSION,
  postGroup,
  roleGranting,
  type ApiGroup,
} from "../../../../../../../support/groups.js";

const groupIds: string[] = [];
let admin: string;

const track = (group: ApiGroup) => {
  groupIds.push(group.id);
  return group;
};

beforeAll(async () => {
  await ensureDefaultOrganization();
  await ensureGroupPermission();
  admin = await getTestPrincipalToken({
    permissions: ["groups.admin", GROUP_PERMISSION],
  });
});

afterAll(async () => {
  await deleteGroups(groupIds);
});

describe("DELETE /v1/admin/groups/:id/members/:userId", () => {
  it("removes the member, returns 204 and takes the group's roles away", async () => {
    const role = await roleGranting();
    const group = track(await postGroup(admin, { roleIds: [role.id] }));
    const user = (await createTestUser()).id;
    await adminApi("POST", `/groups/${group.id}/members`, admin, {
      userIds: [user],
    });

    const res = await adminApi(
      "DELETE",
      `/groups/${group.id}/members/${user}`,
      admin
    );
    expect(res.status).toBe(HTTP_STATUS.NO_CONTENT);
    expect(
      await prisma.groupMember.count({ where: { groupId: group.id } })
    ).toBe(0);
    const perms = await db.roles.getUserPermissions(user);
    expect(perms).not.toContain(GROUP_PERMISSION);
  });

  it("returns 404 for a user who is not a member", async () => {
    const group = track(await postGroup(admin));
    const user = (await createTestUser()).id;
    const res = await adminApi(
      "DELETE",
      `/groups/${group.id}/members/${user}`,
      admin
    );
    expect(res.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it("removes a member from an archived group", async () => {
    const group = track(await postGroup(admin));
    const user = (await createTestUser()).id;
    await adminApi("POST", `/groups/${group.id}/members`, admin, {
      userIds: [user],
    });
    await adminApi("POST", `/groups/${group.id}/archive`, admin);
    const res = await adminApi(
      "DELETE",
      `/groups/${group.id}/members/${user}`,
      admin
    );
    expect(res.status).toBe(HTTP_STATUS.NO_CONTENT);
  });

  it("returns 400 for a userId that is not a UUID", async () => {
    const group = track(await postGroup(admin));
    const res = await adminApi(
      "DELETE",
      `/groups/${group.id}/members/not-a-uuid`,
      admin
    );
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });
});
