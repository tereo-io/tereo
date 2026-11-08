// @module-tag int
// @module-tag auth
// @module-tag security
import { ensureDefaultOrganization } from "../../../../../../utils/defaultOrganization.js";
import { HTTP_STATUS } from "../../../../../support/auth/constants.js";
import { createTestUser } from "../../../../../support/auth/users.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { randomUUID } from "node:crypto";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../../../support/principals.js";
import {
  adminApi,
  deleteGroups,
  delegatedToken,
  ensureGroupPermission,
  GROUP_PERMISSION,
  groupSlug,
  joinOrg,
  postGroup,
  roleGranting,
  type ApiGroup,
} from "../../../../../support/groups.js";

const groupIds: string[] = [];
let admin: string;
/** Also holds GROUP_PERMISSION, so can give groups roles granting it. */
let roleAdmin: string;

const track = (group: ApiGroup) => {
  groupIds.push(group.id);
  return group;
};

const newOrg = () => ensureTestOrganization(`group-perms-${randomUUID()}`);

/** A token for a fresh user with no permissions, holding `memberRole` in the org. */
const orgMemberToken = async (
  orgId: string,
  memberRole: "member" | "admin" | "owner"
) => {
  const userId = randomUUID();
  const token = await getTestPrincipalToken({ userId, permissions: [] });
  await joinOrg(orgId, userId, memberRole);
  return token;
};

const orgUser = async (
  orgId: string,
  memberRole: "member" | "admin" | "owner" = "member"
) => {
  const user = await createTestUser();
  await joinOrg(orgId, user.id, memberRole);
  return user.id;
};

beforeAll(async () => {
  await ensureDefaultOrganization();
  admin = await getTestPrincipalToken({ permissions: ["groups.admin"] });
  await ensureGroupPermission();
  roleAdmin = await getTestPrincipalToken({
    permissions: ["groups.admin", GROUP_PERMISSION],
  });
});

afterAll(async () => {
  await deleteGroups(groupIds);
});

describe("/v1/admin/groups/:id authorization", () => {
  it("an org admin manages their org's group", async () => {
    const orgId = await newOrg();
    const token = await orgMemberToken(orgId, "admin");
    const member = await orgUser(orgId);

    const created = await adminApi("POST", "/groups", token, {
      organizationId: orgId,
      slug: groupSlug("orgadmin"),
      name: "Org admin's group",
    });
    expect(created.status).toBe(HTTP_STATUS.CREATED);
    const group = track(created.body);

    const read = await adminApi("GET", `/groups/${group.id}`, token);
    expect(read.status).toBe(HTTP_STATUS.OK);
    const patched = await adminApi("PATCH", `/groups/${group.id}`, token, {
      name: "Renamed",
    });
    expect(patched.status).toBe(HTTP_STATUS.OK);
    const added = await adminApi("POST", `/groups/${group.id}/members`, token, {
      userIds: [member],
    });
    expect(added.status).toBe(HTTP_STATUS.OK);
    expect(added.body.added).toEqual([member]);
    const members = await adminApi("GET", `/groups/${group.id}/members`, token);
    expect(members.status).toBe(HTTP_STATUS.OK);
    const removed = await adminApi(
      "DELETE",
      `/groups/${group.id}/members/${member}`,
      token
    );
    expect(removed.status).toBe(HTTP_STATUS.NO_CONTENT);
    const archived = await adminApi(
      "POST",
      `/groups/${group.id}/archive`,
      token
    );
    expect(archived.status).toBe(HTTP_STATUS.OK);
  });

  it("an org admin gets 403 on a global group", async () => {
    const orgId = await newOrg();
    const token = await orgMemberToken(orgId, "admin");
    const group = track(await postGroup(admin));

    const read = await adminApi("GET", `/groups/${group.id}`, token);
    expect(read.status).toBe(HTTP_STATUS.FORBIDDEN);
    const create = await adminApi("POST", "/groups", token, {
      slug: groupSlug("global"),
      name: "Global",
    });
    expect(create.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("an org admin gets 403 on another organization's group", async () => {
    const token = await orgMemberToken(await newOrg(), "admin");
    const group = track(
      await postGroup(admin, { organizationId: await newOrg() })
    );
    const res = await adminApi("GET", `/groups/${group.id}`, token);
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("an org member who is not admin gets 403", async () => {
    const orgId = await newOrg();
    const token = await orgMemberToken(orgId, "member");
    const group = track(await postGroup(admin, { organizationId: orgId }));

    const read = await adminApi("GET", `/groups/${group.id}`, token);
    expect(read.status).toBe(HTTP_STATUS.FORBIDDEN);
    const members = await adminApi("GET", `/groups/${group.id}/members`, token);
    expect(members.status).toBe(HTTP_STATUS.FORBIDDEN);
    const list = await adminApi(
      "GET",
      `/groups?organizationId=${orgId}`,
      token
    );
    expect(list.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("an org admin cannot add an org owner", async () => {
    const orgId = await newOrg();
    const token = await orgMemberToken(orgId, "admin");
    const owner = await orgUser(orgId, "owner");
    const group = track(await postGroup(admin, { organizationId: orgId }));

    const res = await adminApi("POST", `/groups/${group.id}/members`, token, {
      userIds: [owner],
    });
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);

    const ownerToken = await orgMemberToken(orgId, "owner");
    const byOwner = await adminApi(
      "POST",
      `/groups/${group.id}/members`,
      ownerToken,
      { userIds: [owner] }
    );
    expect(byOwner.status).toBe(HTTP_STATUS.OK);
  });

  it("an org admin removes a member from an org group holding a role they hold in the org", async () => {
    const orgId = await newOrg();
    const role = await roleGranting();
    const adminId = randomUUID();
    const token = await getTestPrincipalToken({
      userId: adminId,
      permissions: [],
    });
    await joinOrg(orgId, adminId, "admin");
    // Held only in this organization: globally the org admin holds nothing.
    await prisma.userRole.create({
      data: { userId: adminId, roleId: role.id, organizationId: orgId },
    });
    const member = await orgUser(orgId);
    const group = track(
      await postGroup(roleAdmin, { organizationId: orgId, roleIds: [role.id] })
    );

    const added = await adminApi("POST", `/groups/${group.id}/members`, token, {
      userIds: [member],
    });
    expect(added.status).toBe(HTTP_STATUS.OK);
    const removed = await adminApi(
      "DELETE",
      `/groups/${group.id}/members/${member}`,
      token
    );
    expect(removed.status).toBe(HTTP_STATUS.NO_CONTENT);
  });

  it("an org admin cannot add or remove members of an org group holding a role they do not hold there", async () => {
    const orgId = await newOrg();
    const role = await roleGranting();
    const token = await orgMemberToken(orgId, "admin");
    const [existing, newcomer] = [await orgUser(orgId), await orgUser(orgId)];
    const group = track(
      await postGroup(roleAdmin, { organizationId: orgId, roleIds: [role.id] })
    );
    const seeded = await adminApi(
      "POST",
      `/groups/${group.id}/members`,
      roleAdmin,
      { userIds: [existing] }
    );
    expect(seeded.status).toBe(HTTP_STATUS.OK);

    const add = await adminApi("POST", `/groups/${group.id}/members`, token, {
      userIds: [newcomer],
    });
    expect(add.status).toBe(HTTP_STATUS.FORBIDDEN);
    const remove = await adminApi(
      "DELETE",
      `/groups/${group.id}/members/${existing}`,
      token
    );
    expect(remove.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("returns 403, not 404, for a missing group to a caller without groups.read", async () => {
    const token = await orgMemberToken(await newOrg(), "admin");
    const res = await adminApi("GET", `/groups/${randomUUID()}`, token);
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("a delegated core:admin.read token can GET but not POST", async () => {
    const userId = randomUUID();
    await getTestPrincipalToken({ userId, permissions: ["groups.admin"] });
    const token = await delegatedToken(userId, ["core:admin.read"]);
    const group = track(await postGroup(admin));

    const read = await adminApi("GET", `/groups/${group.id}`, token);
    expect(read.status).toBe(HTTP_STATUS.OK);
    const list = await adminApi("GET", "/groups", token);
    expect(list.status).toBe(HTTP_STATUS.OK);

    const create = await adminApi("POST", "/groups", token, {
      slug: groupSlug("delegated"),
      name: "Delegated",
    });
    expect(create.status).toBe(HTTP_STATUS.FORBIDDEN);
    const archive = await adminApi(
      "POST",
      `/groups/${group.id}/archive`,
      token
    );
    expect(archive.status).toBe(HTTP_STATUS.FORBIDDEN);
  });
});
