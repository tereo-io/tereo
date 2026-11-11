// @module-tag int
// @module-tag auth

import { ensureDefaultOrganization } from "../../../../../../utils/defaultOrganization.js";
import { ensureTestOrganization } from "../../../../../support/principals.js";
import { getAccessTokenForUser } from "../../../../../support/auth/login.js";
import { addMembers, createGroup } from "../../../../../../utils/groups.js";
import { createTestClient } from "../../../../../support/auth/clients.js";
import { generateUniqueId } from "../../../../../support/auth/crypto.js";
import { createScimConnection } from "../../../../../support/scim.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { managedWith } from "../../../../../support/scimUsers.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../support/http.js";
import db from "../../../../../../utils/db/index.js";
import {
  BASE_URL,
  HTTP_STATUS,
} from "../../../../../support/auth/constants.js";
import {
  createAdminUser,
  createTestUser,
} from "../../../../../support/auth/users.js";
import {
  deleteGroups,
  ensureGroupPermission,
  joinOrg,
  GROUP_PERMISSION,
  groupSlug,
  PROVISIONING,
  roleGranting,
} from "../../../../../support/groups.js";

interface UserRolesResponse {
  userId: string;
  roles: Array<{ id: string; via: { kind: "direct" } }>;
  groupRoles: Array<Record<string, unknown>>;
  orgGroupRoles: Array<Record<string, unknown>>;
}

let adminToken: string;

beforeAll(async () => {
  await ensureDefaultOrganization();
  await ensureGroupPermission();
  const testClient = await createTestClient();
  adminToken = await getAccessTokenForUser(await createAdminUser(), testClient);
});

describe("GET /v1/admin/users/:id/roles via groups (and PUT keeping them)", () => {
  const groupIds: string[] = [];
  afterAll(() => deleteGroups(groupIds));

  /** A user holding a fresh role through a new global group. */
  const memberOfGroupWithRole = async () => {
    const [user, role] = [await createTestUser(), await roleGranting()];
    const group = await db.$transaction(async (tx) => {
      const { group } = await createGroup(
        PROVISIONING,
        {
          organizationId: null,
          slug: groupSlug("via"),
          name: "Support",
          roleIds: [role.id],
        },
        tx
      );
      await addMembers(PROVISIONING, group.id, [user.id], tx);
      return group;
    });
    groupIds.push(group.id);
    const groupRow = {
      id: role.id,
      name: role.name,
      displayName: role.displayName,
      organizationId: null,
      via: { kind: "group", groupId: group.id },
      group: { id: group.id, slug: group.slug, name: group.name },
    };
    return { userId: user.id, role, groupRow };
  };

  const rolesOf = async (userId: string, roleIds?: string[]) => {
    const url = `${BASE_URL}/v1/admin/users/${userId}/roles`;
    const body = roleIds && { roleIds };
    const res = await fetchJson(body ? "PUT" : "GET", url, adminToken, body);
    expect(res.status).toBe(HTTP_STATUS.OK);
    return res.body as UserRolesResponse;
  };

  it("a role held via a group has via.kind group and groupId", async () => {
    const { userId, groupRow } = await memberOfGroupWithRole();
    const data = await rolesOf(userId);
    expect(data.roles).toEqual([]);
    expect(data.groupRoles).toEqual([groupRow]);
  });

  it("a role held both ways lists via direct and via group", async () => {
    const { userId, role, groupRow } = await memberOfGroupWithRole();
    await prisma.userRole.create({ data: { userId, roleId: role.id } });
    const data = await rolesOf(userId);
    expect(data.roles.map((r) => [r.id, r.via])).toEqual([
      [role.id, { kind: "direct" }],
    ]);
    expect(data.groupRoles).toEqual([groupRow]);
  });

  it("PUT with no roles leaves a group-held role and creates no direct row", async () => {
    const { userId, groupRow } = await memberOfGroupWithRole();
    const data = await rolesOf(userId, []);
    expect(data.roles).toEqual([]);
    expect(data.groupRoles).toEqual([groupRow]);
    const permissions = await db.roles.getUserPermissions(userId);
    expect(permissions).toContain(GROUP_PERMISSION);
    expect(await prisma.userRole.count({ where: { userId } })).toBe(0);
  });

  /** A user holding a fresh role through a new group of a new organization. */
  const memberOfOrgGroupWithRole = async () => {
    const label = `user-roles-${generateUniqueId()}`;
    const orgId = await ensureTestOrganization(label);
    const [user, role] = [await createTestUser(), await roleGranting()];
    await joinOrg(orgId, user.id);
    const group = await db.$transaction(async (tx) => {
      const { group } = await createGroup(
        PROVISIONING,
        {
          organizationId: orgId,
          slug: groupSlug("org-via"),
          name: "Marketing",
          roleIds: [role.id],
        },
        tx
      );
      await addMembers(PROVISIONING, group.id, [user.id], tx);
      return group;
    });
    groupIds.push(group.id);
    const orgGroupRow = {
      id: role.id,
      name: role.name,
      displayName: role.displayName,
      organizationId: orgId,
      via: { kind: "group", groupId: group.id },
      group: { id: group.id, slug: group.slug, name: group.name },
      organization: { id: orgId, name: `Test Org ${label}` },
    };
    return { userId: user.id, orgGroupRow };
  };

  it("lists a role held through an organization's group in orgGroupRoles, with the organization", async () => {
    const { userId, orgGroupRow } = await memberOfOrgGroupWithRole();
    const data = await rolesOf(userId);
    expect(data.groupRoles).toEqual([]);
    expect(data.orgGroupRoles).toEqual([orgGroupRow]);
    expect((await rolesOf(userId, [])).orgGroupRoles).toEqual([orgGroupRow]);
  });

  it("leaves out an organization's group role while the organization is archived", async () => {
    const { userId, orgGroupRow } = await memberOfOrgGroupWithRole();
    await prisma.organization.update({
      where: { id: orgGroupRow.organizationId },
      data: { archivedAt: new Date() },
    });
    expect((await rolesOf(userId)).orgGroupRoles).toEqual([]);
  });
});

describe("GET /v1/admin/users/:id managedBy for a SCIM-managed user", () => {
  const managedBy = async (userId: string) =>
    (await fetchJson("GET", `${BASE_URL}/v1/admin/users/${userId}`, adminToken))
      .body.managedBy;

  it("names the connection's provider", async () => {
    const c = await createScimConnection();
    const user = await managedWith(c);
    expect(await managedBy(user.id)).toEqual({
      kind: "scim",
      id: c.providerId,
      name: "SCIM IdP",
    });
  });

  it("still names it while the link is deleted", async () => {
    const c = await createScimConnection();
    const user = await managedWith(c, {
      idpActive: false,
      deletedAt: new Date(),
    });
    expect(await managedBy(user.id)).toMatchObject({
      kind: "scim",
      id: c.providerId,
    });
  });
});
