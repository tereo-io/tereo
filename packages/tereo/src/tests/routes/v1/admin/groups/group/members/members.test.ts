// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../../../../../../utils/defaultOrganization.js";
import { createTestGuest } from "../../../../../../support/auth/guests.js";
import { SYSTEM_USER_ID } from "../../../../../../../definitions/index.js";
import { HTTP_STATUS } from "../../../../../../support/auth/constants.js";
import { createTestUser } from "../../../../../../support/auth/users.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import db from "../../../../../../../utils/db/index.js";
import { randomUUID } from "node:crypto";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../../../../support/principals.js";
import {
  adminApi,
  deleteGroups,
  ensureGroupPermission,
  GROUP_PERMISSION,
  joinOrg,
  postGroup,
  roleGranting,
  type ApiGroup,
} from "../../../../../../support/groups.js";

const groupIds: string[] = [];
let admin: string;

const track = (group: ApiGroup) => {
  groupIds.push(group.id);
  return group;
};

const newUser = async () => (await createTestUser()).id;

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

describe("POST /v1/admin/groups/:id/members", () => {
  it("adds users, returns those added, and counts them", async () => {
    const group = track(await postGroup(admin));
    const [a, b] = [await newUser(), await newUser()];

    const res = await adminApi("POST", `/groups/${group.id}/members`, admin, {
      userIds: [a, b, a],
    });
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect([...res.body.added].sort()).toEqual([a, b].sort());

    const again = await adminApi("POST", `/groups/${group.id}/members`, admin, {
      userIds: [a],
    });
    expect(again.body.added).toEqual([]);

    const read = await adminApi("GET", `/groups/${group.id}`, admin);
    expect(read.body.memberCount).toBe(2);
  });

  it("gives members the group's roles", async () => {
    const role = await roleGranting();
    const group = track(await postGroup(admin, { roleIds: [role.id] }));
    const user = await newUser();

    await adminApi("POST", `/groups/${group.id}/members`, admin, {
      userIds: [user],
    });
    const perms = await db.roles.getUserPermissions(user);
    expect(perms).toContain(GROUP_PERMISSION);
  });

  it("returns 400 invalid_request for an empty userIds", async () => {
    const group = track(await postGroup(admin));
    const res = await adminApi("POST", `/groups/${group.id}/members`, admin, {
      userIds: [],
    });
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.body.error).toBe("invalid_request");
  });

  it("returns 409 not_org_member for a user outside the group's organization", async () => {
    const orgId = await ensureTestOrganization(`members-${randomUUID()}`);
    const group = track(await postGroup(admin, { organizationId: orgId }));
    const res = await adminApi("POST", `/groups/${group.id}/members`, admin, {
      userIds: [await newUser()],
    });
    expect(res.status).toBe(HTTP_STATUS.CONFLICT);
    expect(res.body.error).toBe("not_org_member");
  });

  it("returns 409 not_org_member for any id outside the organization, whatever it names", async () => {
    const orgId = await ensureTestOrganization(`members-${randomUUID()}`);
    const otherOrg = await ensureTestOrganization(`members-${randomUUID()}`);
    const group = track(await postGroup(admin, { organizationId: orgId }));
    const { user: guest } = await createTestGuest({ organizationId: otherOrg });
    for (const id of [randomUUID(), guest.id, SYSTEM_USER_ID]) {
      const res = await adminApi("POST", `/groups/${group.id}/members`, admin, {
        userIds: [id],
      });
      expect(res.status, id).toBe(HTTP_STATUS.CONFLICT);
      expect(res.body.error, id).toBe("not_org_member");
    }
  });

  it("returns 409 guest_not_allowed for a guest", async () => {
    const orgId = await ensureTestOrganization(`members-${randomUUID()}`);
    const group = track(await postGroup(admin, { organizationId: orgId }));
    const { user: guest } = await createTestGuest({ organizationId: orgId });
    const res = await adminApi("POST", `/groups/${group.id}/members`, admin, {
      userIds: [guest.id],
    });
    expect(res.status).toBe(HTTP_STATUS.CONFLICT);
    expect(res.body.error).toBe("guest_not_allowed");
  });

  it("returns 409 resource_archived for an archived group", async () => {
    const group = track(await postGroup(admin));
    await adminApi("POST", `/groups/${group.id}/archive`, admin);
    const res = await adminApi("POST", `/groups/${group.id}/members`, admin, {
      userIds: [await newUser()],
    });
    expect(res.status).toBe(HTTP_STATUS.CONFLICT);
    expect(res.body.error).toBe("resource_archived");
  });

  it("returns 403 when the caller cannot grant a role the group holds", async () => {
    const role = await roleGranting();
    const group = track(await postGroup(admin, { roleIds: [role.id] }));
    const narrow = await getTestPrincipalToken({
      permissions: ["groups.write"],
    });
    const res = await adminApi("POST", `/groups/${group.id}/members`, narrow, {
      userIds: [await newUser()],
    });
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("lets an org admin add an org member", async () => {
    const orgId = await ensureTestOrganization(`members-${randomUUID()}`);
    const group = track(await postGroup(admin, { organizationId: orgId }));
    const adminId = randomUUID();
    const token = await getTestPrincipalToken({
      userId: adminId,
      permissions: [],
    });
    await joinOrg(orgId, adminId, "admin");
    const member = await newUser();
    await joinOrg(orgId, member);

    const res = await adminApi("POST", `/groups/${group.id}/members`, token, {
      userIds: [member],
    });
    expect(res.status).toBe(HTTP_STATUS.OK);
    const row = await prisma.groupMember.findFirst({
      where: { groupId: group.id, userId: member },
    });
    expect(row?.addedBy).toBe(adminId);
  });
});

describe("GET /v1/admin/groups/:id/members", () => {
  it("lists members with their details, paged by cursor", async () => {
    const group = track(await postGroup(admin));
    const users = [await newUser(), await newUser()];
    await adminApi("POST", `/groups/${group.id}/members`, admin, {
      userIds: users,
    });

    const first = await adminApi(
      "GET",
      `/groups/${group.id}/members?limit=1`,
      admin
    );
    expect(first.status).toBe(HTTP_STATUS.OK);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.data[0]).toEqual({
      userId: expect.any(String),
      email: expect.any(String),
      name: expect.any(String),
      isActive: true,
      addedAt: expect.any(String),
    });
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await adminApi(
      "GET",
      `/groups/${group.id}/members?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      admin
    );
    expect(second.body.data).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    expect(
      [first.body.data[0].userId, second.body.data[0].userId].sort()
    ).toEqual([...users].sort());
  });

  it("continues past a member removed since the previous page", async () => {
    const group = track(await postGroup(admin));
    const users = [await newUser(), await newUser(), await newUser()];
    await adminApi("POST", `/groups/${group.id}/members`, admin, {
      userIds: users,
    });
    const first = await adminApi(
      "GET",
      `/groups/${group.id}/members?limit=1`,
      admin
    );
    await adminApi(
      "DELETE",
      `/groups/${group.id}/members/${first.body.data[0].userId}`,
      admin
    );

    const second = await adminApi(
      "GET",
      `/groups/${group.id}/members?limit=5&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      admin
    );
    expect(second.body.data).toHaveLength(2);
  });
});
