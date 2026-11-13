// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../../../../../../../utils/defaultOrganization.js";
import { getTestPrincipalToken } from "../../../../../../../support/principals.js";
import { HTTP_STATUS } from "../../../../../../../support/auth/constants.js";
import { createTestUser } from "../../../../../../../support/auth/users.js";
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import db from "../../../../../../../../utils/db/index.js";
import { randomUUID } from "node:crypto";
import {
  globalConnection,
  managedUser,
  orgConnection,
  pushedGroup,
} from "../../../../../../../support/scimGroups.js";
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

  it("returns 404 for a non-member who holds more than the caller, and 403 once they are a member", async () => {
    const group = track(await postGroup(admin));
    const userId = randomUUID();
    await getTestPrincipalToken({ userId, permissions: ["admin"] });
    const remove = () =>
      adminApi("DELETE", `/groups/${group.id}/members/${userId}`, admin);

    expect((await remove()).status).toBe(HTTP_STATUS.NOT_FOUND);
    await prisma.groupMember.create({
      data: { groupId: group.id, userId, addedBy: userId },
    });
    expect((await remove()).status).toBe(HTTP_STATUS.FORBIDDEN);
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

describe("DELETE /v1/admin/groups/:id/members/:userId on a SCIM-pushed group", () => {
  it("returns 409 managed_by_scim and keeps the member", async () => {
    const c = await orgConnection();
    const user = await managedUser(c);
    const { id } = await pushedGroup(c, [user.id]);

    const res = await adminApi(
      "DELETE",
      `/groups/${id}/members/${user.id}`,
      admin
    );
    expect(res.status).toBe(HTTP_STATUS.CONFLICT);
    expect(res.body.error).toBe("managed_by_scim");
    expect(await prisma.groupMember.count({ where: { groupId: id } })).toBe(1);
  });

  it("returns 409 managed_by_scim, not 403, on a global group whose member holds more than the caller", async () => {
    const c = await globalConnection();
    const role = await roleGranting();
    const user = await managedUser(c, { inOrg: false });
    const { id } = await pushedGroup(c, []);
    await prisma.groupRole.create({
      data: { groupId: id, roleId: role.id, addedBy: user.id },
    });
    await prisma.groupMember.create({
      data: { groupId: id, userId: user.id, addedBy: user.id },
    });
    const weak = await getTestPrincipalToken({ permissions: ["groups.admin"] });

    const res = await adminApi(
      "DELETE",
      `/groups/${id}/members/${user.id}`,
      weak
    );
    expect(res.status).toBe(HTTP_STATUS.CONFLICT);
    expect(res.body.error).toBe("managed_by_scim");
    expect(await prisma.groupMember.count({ where: { groupId: id } })).toBe(1);
  });
});
