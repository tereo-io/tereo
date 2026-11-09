// @module-tag int
// @module-tag auth

import { ensureDefaultOrganization } from "../../../../../../../../../utils/defaultOrganization.js";
import { getAccessTokenForUser } from "../../../../../../../../support/auth/login.js";
import { createTestClient } from "../../../../../../../../support/auth/clients.js";
import { createTestGuest } from "../../../../../../../../support/auth/guests.js";
import { prisma } from "../../../../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createTestOrganization,
  addTestOrgMember,
  type MemberRolesResponse,
} from "../../../../../../../../support/auth/organizations.js";
import {
  BASE_URL,
  HTTP_STATUS,
} from "../../../../../../../../support/auth/constants.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../../../../../../support/principals.js";
import {
  createTestUser,
  createAdminUser,
  createTestRole,
} from "../../../../../../../../support/auth/users.js";
import {
  adminApi,
  deleteGroups,
  ensureGroupPermission,
  GROUP_PERMISSION,
  joinOrg,
  postGroup,
  roleGranting,
} from "../../../../../../../../support/groups.js";

let adminUser: Awaited<ReturnType<typeof createAdminUser>>;
let adminToken: string;

beforeAll(async () => {
  await ensureDefaultOrganization();
  await ensureGroupPermission();
  const testClient = await createTestClient();
  adminUser = await createAdminUser();
  adminToken = await getAccessTokenForUser(adminUser, testClient);
});

describe("GET /v1/admin/organizations/:id/members/:userId/roles", () => {
  it("should return empty roles for a member with no org-scoped roles", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    await addTestOrgMember(adminToken, org.id, user.id);

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    const data = (await response.json()) as MemberRolesResponse;
    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.organizationId).toBe(org.id);
    expect(data.userId).toBe(user.id);
    expect(data.roles).toEqual([]);
  });

  it("should return 404 not_found when user is not a member", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    const data = (await response.json()) as { error: string };
    expect(data.error).toBe("not_found");
  });
});

describe("PUT /v1/admin/organizations/:id/members/:userId/roles", () => {
  it("should set roles for a member", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    await addTestOrgMember(adminToken, org.id, user.id);
    const role = await createTestRole();

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ roleIds: [role.id] }),
      }
    );

    const data = (await response.json()) as MemberRolesResponse;
    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.roles.length).toBe(1);
    expect(data.roles[0].id).toBe(role.id);

    const membership = await prisma.organizationMember.findUniqueOrThrow({
      where: {
        organizationId_userId: { organizationId: org.id, userId: user.id },
      },
    });
    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        entityType: "OrganizationMember",
        entityId: membership.id,
        action: "UPDATE",
      },
    });
    expect(entry).toMatchObject({
      organizationId: org.id,
      userId: adminUser.id,
      entityName: user.email,
      metadata: {
        action: "roles_changed",
        userId: user.id,
        roleIds: [role.id],
      },
    });
  });

  it("ends a guest's password-only token on a role requiring 2FA", async () => {
    const org = await createTestOrganization(adminToken);
    const { user } = await createTestGuest({ organizationId: org.id });
    const role = await createTestRole();
    await prisma.role.update({
      where: { id: role.id },
      data: { requires2fa: true, guestAssignable: true },
    });
    const token = await getTestPrincipalToken({
      userId: user.id,
      organizationId: org.id,
      permissions: [],
    });
    const me = () =>
      fetch(`${BASE_URL}/v1/account/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    expect((await me()).status).toBe(HTTP_STATUS.OK);

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ roleIds: [role.id] }),
      }
    );
    expect(response.status).toBe(HTTP_STATUS.OK);

    expect((await me()).status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });

  it("should ignore duplicate role ids", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    await addTestOrgMember(adminToken, org.id, user.id);
    const role = await createTestRole();

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ roleIds: [role.id, role.id] }),
      }
    );

    const data = (await response.json()) as MemberRolesResponse;
    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.roles.map((r) => r.id)).toEqual([role.id]);
  });

  it("should clear roles with empty array", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    await addTestOrgMember(adminToken, org.id, user.id);
    const role = await createTestRole();

    // Set a role first
    await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ roleIds: [role.id] }),
      }
    );

    // Clear roles
    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ roleIds: [] }),
      }
    );

    const data = (await response.json()) as MemberRolesResponse;
    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.roles).toEqual([]);
  });

  it("should return 400 for non-existent role IDs", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    await addTestOrgMember(adminToken, org.id, user.id);

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ roleIds: [999999] }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    const error = (await response.json()) as {
      error?: string;
      error_description?: string;
    };
    expect(error.error).toBe("invalid_request");
    expect(error.error_description).toMatch(
      /^Invalid request body\. roleIds\.0: /
    );
  });

  it("should return 400 unknown_role for a role id that names no role", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    await addTestOrgMember(adminToken, org.id, user.id);

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ roleIds: [randomUUID()] }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    const data = (await response.json()) as { error: string };
    expect(data.error).toBe("unknown_role");
  });

  it("should return 404 not_found when user is not a member", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    const role = await createTestRole();

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ roleIds: [role.id] }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    const data = (await response.json()) as { error: string };
    expect(data.error).toBe("not_found");
  });
});

const orgGroupIds: string[] = [];

let groupToken: string;

beforeAll(async () => {
  groupToken = await getTestPrincipalToken({
    permissions: ["groups.admin", "organizations.admin", GROUP_PERMISSION],
  });
});

afterAll(() => deleteGroups(orgGroupIds));

const memberRoles = (orgId: string, userId: string, roleIds?: string[]) =>
  adminApi(
    roleIds ? "PUT" : "GET",
    `/organizations/${orgId}/members/${userId}/roles`,
    groupToken,
    roleIds && { roleIds }
  );

const orgGroupWithRole = async (orgId: string, userId: string) => {
  const role = await roleGranting();
  const group = await postGroup(groupToken, {
    organizationId: orgId,
    roleIds: [role.id],
  });
  orgGroupIds.push(group.id);
  const res = await adminApi(
    "POST",
    `/groups/${group.id}/members`,
    groupToken,
    {
      userIds: [userId],
    }
  );
  expect(res.status).toBeLessThan(300);
  return {
    role,
    group,
    row: {
      id: role.id,
      name: role.name,
      displayName: role.displayName,
      organizationId: orgId,
      via: { kind: "group", groupId: group.id },
      group: { id: group.id, slug: group.slug, name: group.name },
    },
  };
};

describe("member roles of an organization, with group roles", () => {
  it("GET lists a role held through the org's group apart from direct roles", async () => {
    const orgId = await ensureTestOrganization(`mr-groups-${randomUUID()}`);
    const user = await createTestUser();
    await joinOrg(orgId, user.id);
    const { row } = await orgGroupWithRole(orgId, user.id);

    const res = await memberRoles(orgId, user.id);
    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual([]);
    expect(res.body.groupRoles).toEqual([row]);
  });

  it("PUT keeps direct roles in roles (via direct) and returns groupRoles", async () => {
    const orgId = await ensureTestOrganization(`mr-groups-${randomUUID()}`);
    const user = await createTestUser();
    await joinOrg(orgId, user.id);
    const { role, row } = await orgGroupWithRole(orgId, user.id);

    const res = await memberRoles(orgId, user.id, [role.id]);
    expect(res.status).toBe(200);
    expect(res.body.roles.map((r: { id: string }) => r.id)).toEqual([role.id]);
    expect(res.body.roles[0].via).toEqual({ kind: "direct" });
    expect(res.body.groupRoles).toEqual([row]);
  });

  it("shows groupRoles only to who may read the org's groups, or to the member themselves", async () => {
    const orgId = await ensureTestOrganization(`mr-groups-${randomUUID()}`);
    const user = await createTestUser();
    await joinOrg(orgId, user.id);
    const { row } = await orgGroupWithRole(orgId, user.id);

    const callerIn = async (
      memberRole: "member" | "admin" | null,
      permissions: string[] = []
    ) => {
      const userId = randomUUID();
      const token = await getTestPrincipalToken({ userId, permissions });
      if (memberRole) await joinOrg(orgId, userId, memberRole);
      return token;
    };
    const read = async (token: string, target = user.id) => {
      const res = await adminApi(
        "GET",
        `/organizations/${orgId}/members/${target}/roles`,
        token
      );
      expect(res.status).toBe(200);
      return res.body.groupRoles;
    };

    // A plain member sees the other members' direct roles, not their groups.
    expect(await read(await callerIn("member"))).toEqual([]);
    // Nor does organizations.read, which reads no groups.
    expect(await read(await callerIn(null, ["organizations.read"]))).toEqual(
      []
    );
    expect(await read(await callerIn("admin"))).toEqual([row]);
    expect(
      await read(await callerIn(null, ["organizations.read", "groups.read"]))
    ).toEqual([row]);
    expect(await read(await callerIn(null, ["organizations.write"]))).toEqual([
      row,
    ]);
    // The member themselves.
    const self = await getTestPrincipalToken({
      userId: user.id,
      permissions: [],
    });
    expect(await read(self)).toEqual([row]);
  });

  it("omits global groups, other organizations' groups and archived groups", async () => {
    const orgId = await ensureTestOrganization(`mr-groups-${randomUUID()}`);
    const otherId = await ensureTestOrganization(`mr-groups-${randomUUID()}`);
    const user = await createTestUser();
    await joinOrg(orgId, user.id);
    await joinOrg(otherId, user.id);
    await orgGroupWithRole(otherId, user.id);
    const archived = await orgGroupWithRole(orgId, user.id);
    await adminApi("POST", `/groups/${archived.group.id}/archive`, groupToken);
    const globalRole = await roleGranting();
    const globalGroup = await postGroup(groupToken, {
      roleIds: [globalRole.id],
    });
    orgGroupIds.push(globalGroup.id);
    await adminApi("POST", `/groups/${globalGroup.id}/members`, groupToken, {
      userIds: [user.id],
    });

    const res = await memberRoles(orgId, user.id);
    expect(res.status).toBe(200);
    expect(res.body.groupRoles).toEqual([]);
    expect(await prisma.groupMember.count({ where: { userId: user.id } })).toBe(
      3
    );
  });
});
