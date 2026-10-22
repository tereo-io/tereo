// @module-tag int
// @module-tag auth
import { ensurePermission, makeServiceOf } from "../../support/testService.js";
import { SYSTEM_USER_ID } from "../../../definitions/index.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { fetchJson } from "../../support/http.js";
import db from "../../../utils/db/index.js";
import { randomUUID } from "crypto";
import {
  ensureTestMembership,
  ensureTestOrganization,
  ensureTestUser,
  getTestPrincipalToken,
} from "../../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  addTestOrgMember,
  createTestClient,
  createTestOrganization,
  createTestRole,
  createTestUser,
} from "../../support/auth.js";

const CLIENT_IP = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;

const call = (method: string, path: string, token: string, body?: unknown) =>
  // Its own client address: the limiters run at production values.
  fetchJson(method, `${BASE_URL}${path}`, token, body, {
    "X-Forwarded-For": CLIENT_IP,
  });

const permissionId = async (name: string) =>
  (await prisma.permission.findUniqueOrThrow({ where: { name } })).id;

/** A custom role granting `permissions`. */
const roleWith = async (
  permissions: string[],
  options: { requires2fa?: boolean } = {}
) => {
  const role = await createTestRole();
  for (const name of permissions) {
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: await permissionId(name) },
    });
  }
  if (options.requires2fa) {
    await prisma.role.update({
      where: { id: role.id },
      data: { requires2fa: true },
    });
  }
  return role;
};

let adminToken: string;

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({ permissions: ["admin"] });
});

describe("org-assignable permissions", () => {
  it("count only those from an org-scoped assignment", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    await addTestOrgMember(adminToken, org.id, user.id);
    // Written directly, as an assignment made before the rule would be.
    const role = await roleWith(["webhooks.read", "users.write"]);
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id, organizationId: org.id },
    });
    expect(await db.roles.countInertOrgAssignments()).toBeGreaterThan(0);

    const token = await getTestPrincipalToken({
      userId: user.id,
      organizationId: org.id,
      permissions: [],
    });
    const me = await call("GET", "/v1/account/me", token);
    expect(me.status).toBe(HTTP_STATUS.OK);
    expect(me.body.permissions).toContain("webhooks.read");
    expect(me.body.permissions).not.toContain("users.write");
    expect((await call("GET", "/v1/admin/users", token)).status).toBe(
      HTTP_STATUS.FORBIDDEN
    );
  });

  it("keep organizations.write's bypass out of an org-scoped role", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    await addTestOrgMember(adminToken, org.id, user.id);
    const role = await roleWith(["organizations.write"]);
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id, organizationId: org.id },
    });
    const token = await getTestPrincipalToken({
      userId: user.id,
      organizationId: org.id,
      permissions: [],
    });

    const res = await call(
      "PATCH",
      `/v1/admin/organizations/${org.id}`,
      token,
      {
        name: "Renamed by a member",
      }
    );
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("refuse a role with a non-org-assignable permission, even from admin", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    await addTestOrgMember(adminToken, org.id, user.id);
    const role = await roleWith(["webhooks.read", "organizations.write"]);

    const res = await call(
      "PUT",
      `/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
      adminToken,
      { roleIds: [role.id] }
    );
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.body.error).toBe("not_org_assignable");
    expect(res.body.error_description).toContain("organizations.write");
    expect(res.body.error_description).not.toContain("webhooks.read");
  });

  it("may be taken from a member only by a caller holding them there", async () => {
    const org = await createTestOrganization(adminToken);
    const member = await createTestUser();
    await addTestOrgMember(adminToken, org.id, member.id);
    const role = await roleWith(["webhooks.read"]);
    await prisma.userRole.create({
      data: { userId: member.id, roleId: role.id, organizationId: org.id },
    });
    const orgAdmin = await createTestUser();
    await addTestOrgMember(adminToken, org.id, orgAdmin.id, "admin");
    const path = `/v1/admin/organizations/${org.id}/members/${member.id}/roles`;

    const weak = await getTestPrincipalToken({
      userId: orgAdmin.id,
      organizationId: org.id,
      permissions: [],
    });
    const refused = await call("PUT", path, weak, { roleIds: [] });
    expect(refused.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(refused.body.error_description).toContain("webhooks.read");
    expect(
      await prisma.userRole.count({
        where: { userId: member.id, roleId: role.id },
      })
    ).toBe(1);

    const holder = await getTestPrincipalToken({
      userId: orgAdmin.id,
      organizationId: org.id,
      permissions: ["webhooks.read"],
    });
    expect((await call("PUT", path, holder, { roleIds: [] })).status).toBe(
      HTTP_STATUS.OK
    );
  });

  it("show on a role's permissions", async () => {
    const role = await roleWith(["webhooks.read", "users.read"]);
    const res = await call("GET", `/v1/admin/roles/${role.id}`, adminToken);
    expect(res.status).toBe(HTTP_STATUS.OK);
    const flags = Object.fromEntries(
      res.body.permissions.map(
        (p: { name: string; orgAssignable: boolean }) => [
          p.name,
          p.orgAssignable,
        ]
      )
    );
    expect(flags).toEqual({ "webhooks.read": true, "users.read": false });
  });

  it("filter the permission list", async () => {
    const res = await call(
      "GET",
      "/v1/admin/permissions?filter[orgAssignable]=true&limit=100",
      adminToken
    );
    expect(res.status).toBe(HTTP_STATUS.OK);
    const names = res.body.data.map((p: { name: string }) => p.name);
    expect(names).toContain("webhooks.read");
    expect(names).not.toContain("admin");
    expect(
      res.body.data.every((p: { orgAssignable: boolean }) => p.orgAssignable)
    ).toBe(true);
  });
});

describe("inactive organizations", () => {
  const setup = async () => {
    const org = await createTestOrganization(adminToken);
    const owner = await createTestUser();
    const orgAdmin = await createTestUser();
    const member = await createTestUser();
    await addTestOrgMember(adminToken, org.id, owner.id, "owner");
    await addTestOrgMember(adminToken, org.id, orgAdmin.id, "admin");
    await addTestOrgMember(adminToken, org.id, member.id);
    return {
      org,
      member,
      ownerToken: await getTestPrincipalToken({
        userId: owner.id,
        permissions: [],
      }),
      orgAdminToken: await getTestPrincipalToken({
        userId: orgAdmin.id,
        permissions: ["webhooks.read"],
      }),
    };
  };

  const patch = (orgId: string, token: string, body: unknown) =>
    call("PATCH", `/v1/admin/organizations/${orgId}`, token, body);

  it("an owner can neither deactivate nor reactivate", async () => {
    const { org, ownerToken } = await setup();
    expect((await patch(org.id, ownerToken, { isActive: false })).status).toBe(
      HTTP_STATUS.FORBIDDEN
    );

    expect((await patch(org.id, adminToken, { isActive: false })).status).toBe(
      HTTP_STATUS.OK
    );
    expect((await patch(org.id, ownerToken, { isActive: true })).status).toBe(
      HTTP_STATUS.FORBIDDEN
    );
    const after = await prisma.organization.findUniqueOrThrow({
      where: { id: org.id },
    });
    expect(after.isActive).toBe(false);
  });

  it("an owner can still rename an active organization", async () => {
    const { org, ownerToken } = await setup();
    const res = await patch(org.id, ownerToken, {
      name: "Renamed by its owner",
      isActive: true,
    });
    expect(res.status).toBe(HTTP_STATUS.OK);
  });

  it("its members cannot add members or assign roles; the platform can", async () => {
    const { org, member, ownerToken, orgAdminToken } = await setup();
    expect((await patch(org.id, adminToken, { isActive: false })).status).toBe(
      HTTP_STATUS.OK
    );
    const newcomer = await createTestUser();
    const role = await roleWith(["webhooks.read"]);

    for (const token of [ownerToken, orgAdminToken]) {
      const add = await call(
        "POST",
        `/v1/admin/organizations/${org.id}/members`,
        token,
        { userId: newcomer.id }
      );
      expect(add.status).toBe(HTTP_STATUS.FORBIDDEN);
      const assign = await call(
        "PUT",
        `/v1/admin/organizations/${org.id}/members/${member.id}/roles`,
        token,
        { roleIds: [role.id] }
      );
      expect(assign.status).toBe(HTTP_STATUS.FORBIDDEN);
    }

    // Reading stays open to members.
    expect(
      (
        await call(
          "GET",
          `/v1/admin/organizations/${org.id}/members`,
          ownerToken
        )
      ).status
    ).toBe(HTTP_STATUS.OK);

    const add = await call(
      "POST",
      `/v1/admin/organizations/${org.id}/members`,
      adminToken,
      { userId: newcomer.id }
    );
    expect(add.status).toBe(HTTP_STATUS.CREATED);
  });
});

describe("POST /admin/organizations/:id/members refuses", () => {
  const add = async (userId: string) => {
    const org = await createTestOrganization(adminToken);
    return call(
      "POST",
      `/v1/admin/organizations/${org.id}/members`,
      adminToken,
      {
        userId,
      }
    );
  };

  it("the system user", async () => {
    const res = await add(SYSTEM_USER_ID);
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.body.error).toBe("user_not_addable");
  });

  it("a service account", async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { userType: "service_account" },
    });
    const res = await add(user.id);
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.body.error).toBe("user_not_addable");
  });

  it("an inactive user", async () => {
    const user = await createTestUser({ isActive: false });
    const res = await add(user.id);
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.body.error).toBe("user_not_addable");
  });
});

describe("adding organization members", () => {
  const setup = async () => {
    const org = await createTestOrganization(adminToken);
    const owner = await createTestUser();
    const orgAdmin = await createTestUser();
    await addTestOrgMember(adminToken, org.id, owner.id, "owner");
    await addTestOrgMember(adminToken, org.id, orgAdmin.id, "admin");
    return {
      org,
      ownerToken: await getTestPrincipalToken({
        userId: owner.id,
        permissions: [],
      }),
      orgAdminToken: await getTestPrincipalToken({
        userId: orgAdmin.id,
        permissions: [],
      }),
    };
  };

  it("needs the platform's organizations.write, not an owner or admin role", async () => {
    const { org, ownerToken, orgAdminToken } = await setup();
    const newcomer = await createTestUser();

    for (const token of [ownerToken, orgAdminToken]) {
      const res = await call(
        "POST",
        `/v1/admin/organizations/${org.id}/members`,
        token,
        { userId: newcomer.id }
      );
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    }
    expect(
      await prisma.organizationMember.count({
        where: { organizationId: org.id, userId: newcomer.id },
      })
    ).toBe(0);

    const platformToken = await getTestPrincipalToken({
      permissions: ["organizations.write"],
    });
    const res = await call(
      "POST",
      `/v1/admin/organizations/${org.id}/members`,
      platformToken,
      { userId: newcomer.id }
    );
    expect(res.status).toBe(HTTP_STATUS.CREATED);
  });

  it("leaves an org admin changing tiers and removing members", async () => {
    const { org, orgAdminToken } = await setup();
    const member = await createTestUser();
    await addTestOrgMember(adminToken, org.id, member.id);

    const tier = await call(
      "PATCH",
      `/v1/admin/organizations/${org.id}/members/${member.id}`,
      orgAdminToken,
      { memberRole: "admin" }
    );
    expect(tier.status).toBe(HTTP_STATUS.OK);

    const remove = await call(
      "DELETE",
      `/v1/admin/organizations/${org.id}/members/${member.id}`,
      orgAdminToken
    );
    expect(remove.status).toBeLessThan(300);
    expect(
      await prisma.organizationMember.count({
        where: { organizationId: org.id, userId: member.id },
      })
    ).toBe(0);
  });
});

describe("GET /account/me roles", () => {
  it("are global plus the token's organization, unexpired", async () => {
    const orgA = await createTestOrganization(adminToken);
    const orgB = await createTestOrganization(adminToken);
    const user = await createTestUser();
    await addTestOrgMember(adminToken, orgA.id, user.id);
    await addTestOrgMember(adminToken, orgB.id, user.id);

    const global = await createTestRole();
    const expired = await createTestRole();
    const inA = await createTestRole();
    const inB = await createTestRole();
    await prisma.userRole.createMany({
      data: [
        { userId: user.id, roleId: global.id },
        {
          userId: user.id,
          roleId: expired.id,
          expiresAt: new Date(Date.now() - 60_000),
        },
        { userId: user.id, roleId: inA.id, organizationId: orgA.id },
        { userId: user.id, roleId: inB.id, organizationId: orgB.id },
      ],
    });

    const roleIds = async (organizationId: string | null) => {
      const token = await getTestPrincipalToken({
        userId: user.id,
        organizationId,
        permissions: [],
      });
      const me = await call("GET", "/v1/account/me", token);
      expect(me.status).toBe(HTTP_STATUS.OK);
      return me.body.roles.map((r: { id: string }) => r.id).sort();
    };

    expect(await roleIds(orgA.id)).toEqual([global.id, inA.id].sort());
    expect(await roleIds(null)).toEqual([global.id]);
  });
});

/**
 * A role held in an organization counts only where that organization is
 * named: never for a token, check or profile that names none.
 */
describe("Org-scoped roles without an organization", () => {
  const userId = randomUUID();
  let orgId: string;
  let orglessToken: string;
  let orgToken: string;

  beforeAll(async () => {
    await ensureTestUser(userId);
    orgId = await ensureTestOrganization(`perm-scope-${userId}`);
    const permission = await ensurePermission("webhooks.read");
    const role = await prisma.role.create({
      data: {
        name: `org-scoped-${userId}`,
        displayName: "Org-scoped webhooks.read",
        rolePermissions: { create: [{ permissionId: permission.id }] },
      },
    });
    await prisma.userRole.create({
      data: { userId, roleId: role.id, organizationId: orgId },
    });

    orglessToken = await getTestPrincipalToken({
      userId,
      organizationId: null,
      permissions: [],
    });
    orgToken = await getTestPrincipalToken({
      userId,
      organizationId: orgId,
      permissions: [],
    });
  });

  it("an org-less token does not carry the org role's permissions", async () => {
    const response = await fetch(`${BASE_URL}/v1/webhooks/webhooks`, {
      headers: { Authorization: `Bearer ${orglessToken}` },
    });
    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);

    const me = await fetch(`${BASE_URL}/v1/account/me`, {
      headers: { Authorization: `Bearer ${orglessToken}` },
    });
    expect(me.status).toBe(HTTP_STATUS.OK);
    const profile = (await me.json()) as { permissions: string[] };
    expect(profile.permissions).not.toContain("webhooks.read");
  });

  it("a token for that organization does", async () => {
    const response = await fetch(`${BASE_URL}/v1/webhooks/webhooks`, {
      headers: { Authorization: `Bearer ${orgToken}` },
    });
    expect(response.status).toBe(HTTP_STATUS.OK);

    const me = await fetch(`${BASE_URL}/v1/account/me`, {
      headers: { Authorization: `Bearer ${orgToken}` },
    });
    const profile = (await me.json()) as { permissions: string[] };
    expect(profile.permissions).toContain("webhooks.read");
  });

  it("the admin view of the user's permissions lists only global ones", async () => {
    const admin = await getTestPrincipalToken({ permissions: ["users.read"] });
    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${userId}/permissions`,
      { headers: { Authorization: `Bearer ${admin}` } }
    );
    expect(response.status).toBe(HTTP_STATUS.OK);
    const body = (await response.json()) as { permissions: string[] };
    expect(body.permissions).not.toContain("webhooks.read");
  });

  it("check-permission counts the org role only for a client of the organization", async () => {
    const check = async (organizationId: string | null) => {
      const client = await createTestClient({ clientType: "confidential" });
      if (organizationId) {
        await prisma.oAuthClient.update({
          where: { id: client.id },
          data: { organizationId },
        });
      } else {
        // A client of no organization is answered only if it is a service's.
        await makeServiceOf(client.id);
      }
      const response = await fetch(`${BASE_URL}/oauth/check-permission`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${client.clientId}:${client.plainSecret}`
          ).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ user_id: userId, permission: "webhooks.read" }),
      });
      expect(response.status).toBe(HTTP_STATUS.OK);
      return ((await response.json()) as { granted: boolean }).granted;
    };

    await ensureTestMembership(userId, orgId);
    expect(await check(null)).toBe(false);
    expect(await check(orgId)).toBe(true);
  });
});
