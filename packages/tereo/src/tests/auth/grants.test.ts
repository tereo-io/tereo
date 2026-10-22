import { CORE_SERVICE_ID, SYSTEM_USER_ID } from "../../definitions/index.js";
import { getTestPrincipalToken } from "../support/principals.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { fetchJson } from "../support/http.js";
import db from "../../utils/db/index.js";
import {
  BASE_URL,
  HTTP_STATUS,
  addTestOrgMember,
  createTestOrganization,
  createTestRole,
  createTestUser,
  getUiAccessTokenForUser,
} from "../support/auth.js";

// Who may grant what: only what you hold (users, roles, organizations),
// org-assignable permissions, inactive organizations, which users can be
// members, and the scope of the roles behind 2FA and /account/me.

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

describe("only grant what you hold", () => {
  describe("PUT /admin/users/:id/roles", () => {
    let callerId: string;
    let callerToken: string;

    beforeAll(async () => {
      callerId = (await createTestUser()).id;
      callerToken = await getTestPrincipalToken({
        userId: callerId,
        permissions: ["users.write"],
      });
    });

    const setRoles = (userId: string, roleIds: string[], token = callerToken) =>
      call("PUT", `/v1/admin/users/${userId}/roles`, token, { roleIds });

    it("refuses users.write giving itself admin", async () => {
      const admin = await prisma.role.findFirstOrThrow({
        where: { name: "admin", serviceId: CORE_SERVICE_ID },
      });
      const current = await prisma.userRole.findMany({
        where: { userId: callerId, organizationId: null },
      });
      const res = await setRoles(callerId, [
        ...current.map((ur) => ur.roleId),
        admin.id,
      ]);
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(res.body.error_description).toContain("admin");
      expect(
        await prisma.userRole.count({
          where: { userId: callerId, roleId: admin.id },
        })
      ).toBe(0);
    });

    it("refuses a role granting a permission the caller lacks", async () => {
      const target = await createTestUser();
      const role = await roleWith(["settings.write"]);
      const res = await setRoles(target.id, [role.id]);
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(res.body.error_description).toContain("settings.write");
    });

    it("allows a role whose permissions the caller holds", async () => {
      const target = await createTestUser();
      const role = await roleWith(["users.read"]);
      const res = await setRoles(target.id, [role.id]);
      expect(res.status).toBe(HTTP_STATUS.OK);
    });

    it("keeps a role the user already holds without checking it", async () => {
      const target = await createTestUser();
      const held = await roleWith(["settings.write"]);
      expect((await setRoles(target.id, [held.id], adminToken)).status).toBe(
        HTTP_STATUS.OK
      );
      const added = await roleWith(["users.read"]);
      const res = await setRoles(target.id, [held.id, added.id]);
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.body.roles.map((r: { id: string }) => r.id).sort()).toEqual(
        [held.id, added.id].sort()
      );
    });

    it("lets admin grant anything", async () => {
      const target = await createTestUser();
      const role = await roleWith(["settings.write", "clients.admin"]);
      const res = await setRoles(target.id, [role.id], adminToken);
      expect(res.status).toBe(HTTP_STATUS.OK);
    });
  });

  describe("PUT /admin/roles/:id/permissions", () => {
    let callerToken: string;

    beforeAll(async () => {
      callerToken = await getTestPrincipalToken({
        permissions: ["roles.write"],
      });
    });

    const setPermissions = (roleId: string, names: string[], token: string) =>
      Promise.all(names.map(permissionId)).then((permissionIds) =>
        call("PUT", `/v1/admin/roles/${roleId}/permissions`, token, {
          permissionIds,
        })
      );

    it("refuses adding a permission the caller lacks", async () => {
      const role = await createTestRole();
      const res = await setPermissions(role.id, ["admin"], callerToken);
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(
        await prisma.rolePermission.count({ where: { roleId: role.id } })
      ).toBe(0);
    });

    it("allows a permission the caller holds", async () => {
      const role = await createTestRole();
      const res = await setPermissions(role.id, ["roles.read"], callerToken);
      expect(res.status).toBe(HTTP_STATUS.OK);
    });

    it("keeps permissions already on the role without checking them", async () => {
      const role = await roleWith(["settings.write"]);
      const res = await setPermissions(
        role.id,
        ["settings.write", "roles.read"],
        callerToken
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(
        res.body.permissions.map((p: { name: string }) => p.name).sort()
      ).toEqual(["roles.read", "settings.write"]);
    });

    it("lets admin add anything", async () => {
      const role = await createTestRole();
      const res = await setPermissions(role.id, ["settings.write"], adminToken);
      expect(res.status).toBe(HTTP_STATUS.OK);
    });

    describe("on a role assigned within an organization", () => {
      const assignedInOrg = async () => {
        const org = await createTestOrganization(adminToken);
        const user = await createTestUser();
        await addTestOrgMember(adminToken, org.id, user.id);
        const role = await roleWith(["webhooks.read"]);
        await prisma.userRole.create({
          data: { userId: user.id, roleId: role.id, organizationId: org.id },
        });
        return { org, role };
      };

      it("refuses adding a permission that is not org-assignable", async () => {
        const { org, role } = await assignedInOrg();
        const res = await setPermissions(
          role.id,
          ["webhooks.read", "settings.write"],
          adminToken
        );
        expect(res.status).toBe(409);
        expect(res.body.error).toBe("role_assigned_in_org");
        expect(res.body.error_description).toContain(org.id);
        expect(res.body.error_description).toContain("settings.write");
        expect(
          await prisma.rolePermission.count({ where: { roleId: role.id } })
        ).toBe(1);
      });

      it("allows adding an org-assignable one, and removing any", async () => {
        const { role } = await assignedInOrg();
        expect(
          (
            await setPermissions(
              role.id,
              ["webhooks.read", "webhooks.write"],
              adminToken
            )
          ).status
        ).toBe(HTTP_STATUS.OK);
        expect(
          (await setPermissions(role.id, ["webhooks.write"], adminToken)).status
        ).toBe(HTTP_STATUS.OK);
      });

      it("allows any once only global assignments remain", async () => {
        const role = await roleWith(["webhooks.read"]);
        const user = await createTestUser();
        await prisma.userRole.create({
          data: { userId: user.id, roleId: role.id },
        });
        const res = await setPermissions(
          role.id,
          ["webhooks.read", "settings.write"],
          adminToken
        );
        expect(res.status).toBe(HTTP_STATUS.OK);
      });
    });
  });

  describe("POST /admin/roles/:id/duplicate", () => {
    let callerToken: string;

    beforeAll(async () => {
      callerToken = await getTestPrincipalToken({
        permissions: ["roles.write"],
      });
    });

    const duplicate = (roleId: string, token: string) =>
      call("POST", `/v1/admin/roles/${roleId}/duplicate`, token, {
        name: `dup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });

    it("refuses a source granting what the caller lacks", async () => {
      const source = await roleWith(["roles.read", "settings.write"]);
      const res = await duplicate(source.id, callerToken);
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(res.body.error_description).toContain("settings.write");
    });

    it("duplicates a role whose permissions the caller holds", async () => {
      const source = await roleWith(["roles.read"]);
      const res = await duplicate(source.id, callerToken);
      expect(res.status).toBe(HTTP_STATUS.CREATED);
    });

    it("lets admin duplicate anything", async () => {
      const source = await roleWith(["settings.write"]);
      const res = await duplicate(source.id, adminToken);
      expect(res.status).toBe(HTTP_STATUS.CREATED);
    });
  });

  describe("PATCH /admin/roles/:id reactivating", () => {
    let callerToken: string;

    beforeAll(async () => {
      callerToken = await getTestPrincipalToken({
        permissions: ["roles.write"],
      });
    });

    const inactiveRoleWith = async (permissions: string[]) => {
      const role = await roleWith(permissions);
      await prisma.role.update({
        where: { id: role.id },
        data: { isActive: false },
      });
      return role;
    };

    const reactivate = (roleId: string, token: string) =>
      call("PATCH", `/v1/admin/roles/${roleId}`, token, { isActive: true });

    it("refuses a role granting what the caller lacks", async () => {
      const role = await inactiveRoleWith(["settings.write"]);
      const res = await reactivate(role.id, callerToken);
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(res.body.error_description).toContain("settings.write");
      expect(
        (await prisma.role.findUniqueOrThrow({ where: { id: role.id } }))
          .isActive
      ).toBe(false);
    });

    it("reactivates a role whose permissions the caller holds", async () => {
      const role = await inactiveRoleWith(["roles.read"]);
      const res = await reactivate(role.id, callerToken);
      expect(res.status).toBe(HTTP_STATUS.OK);
    });

    it("lets admin reactivate anything", async () => {
      const role = await inactiveRoleWith(["settings.write"]);
      const res = await reactivate(role.id, adminToken);
      expect(res.status).toBe(HTTP_STATUS.OK);
    });
  });
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

describe("roles requiring 2FA", () => {
  const requiring = async () => roleWith([], { requires2fa: true });

  const required = async (userId: string) => ({
    needs: await db.totp.userNeedsTotp(userId),
    status: (await db.totp.getUserTotpStatus(userId)).totpRequired,
    roles: await db.totp.userRolesRequire2fa(userId),
  });
  const all = (value: boolean) => ({
    needs: value,
    status: value,
    roles: value,
  });

  it("count a global assignment", async () => {
    const user = await createTestUser();
    const role = await requiring();
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id },
    });
    expect(await required(user.id)).toEqual(all(true));

    const token = await getTestPrincipalToken({
      userId: user.id,
      permissions: [],
    });
    const me = await call("GET", "/v1/account/me", token);
    expect(me.body.totp.required).toBe(true);
  });

  it("ignore an expired assignment", async () => {
    const user = await createTestUser();
    const role = await requiring();
    await prisma.userRole.create({
      data: {
        userId: user.id,
        roleId: role.id,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    expect(await required(user.id)).toEqual(all(false));
  });

  it("ignore a retired or inactive role", async () => {
    const user = await createTestUser();
    const retired = await requiring();
    const inactive = await requiring();
    await prisma.role.update({
      where: { id: retired.id },
      data: { retiredAt: new Date() },
    });
    await prisma.role.update({
      where: { id: inactive.id },
      data: { isActive: false },
    });
    await prisma.userRole.createMany({
      data: [
        { userId: user.id, roleId: retired.id },
        { userId: user.id, roleId: inactive.id },
      ],
    });
    expect(await required(user.id)).toEqual(all(false));
  });

  it("count an org-scoped assignment in an active organization the user belongs to", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    await addTestOrgMember(adminToken, org.id, user.id);
    const role = await requiring();
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id, organizationId: org.id },
    });
    expect(await required(user.id)).toEqual(all(true));

    // Deactivated, the organization cannot be chosen at sign-in.
    await prisma.organization.update({
      where: { id: org.id },
      data: { isActive: false },
    });
    expect(await required(user.id)).toEqual(all(false));
  });

  it("ignore an org-scoped assignment without the membership", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    const role = await requiring();
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id, organizationId: org.id },
    });
    expect(await required(user.id)).toEqual(all(false));
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

describe("global grants count only global permissions", () => {
  // webhooks.read is org-assignable: held through an org-scoped role, it is
  // in an org token's permissions but reaches only that organization.
  const callerIn = async (globalPermissions: string[]) => {
    const org = await createTestOrganization(adminToken);
    const caller = await createTestUser();
    await addTestOrgMember(adminToken, org.id, caller.id);
    const orgRole = await roleWith(["webhooks.read"]);
    await prisma.userRole.create({
      data: { userId: caller.id, roleId: orgRole.id, organizationId: org.id },
    });
    const token = await getTestPrincipalToken({
      userId: caller.id,
      organizationId: org.id,
      permissions: globalPermissions,
    });
    const me = await call("GET", "/v1/account/me", token);
    expect(me.body.permissions).toContain("webhooks.read");
    return token;
  };

  it("refuses adding an org-held permission to a global role", async () => {
    const token = await callerIn(["roles.write"]);
    const role = await createTestRole();
    const res = await call(
      "PUT",
      `/v1/admin/roles/${role.id}/permissions`,
      token,
      {
        permissionIds: [await permissionId("webhooks.read")],
      }
    );
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(res.body.error_description).toContain("webhooks.read");
  });

  it("refuses granting a global role carrying an org-held permission", async () => {
    const token = await callerIn(["users.write"]);
    const target = await createTestUser();
    const role = await roleWith(["webhooks.read"]);
    const res = await call("PUT", `/v1/admin/users/${target.id}/roles`, token, {
      roleIds: [role.id],
    });
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(res.body.error_description).toContain("webhooks.read");
  });

  it("refuses duplicating a role carrying an org-held permission", async () => {
    const token = await callerIn(["roles.write"]);
    const source = await roleWith(["webhooks.read"]);
    const res = await call(
      "POST",
      `/v1/admin/roles/${source.id}/duplicate`,
      token,
      {
        name: `dup-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      }
    );
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("allows both with the permission held globally", async () => {
    const token = await callerIn([
      "roles.write",
      "users.write",
      "webhooks.read",
    ]);
    const role = await createTestRole();
    const set = await call(
      "PUT",
      `/v1/admin/roles/${role.id}/permissions`,
      token,
      {
        permissionIds: [await permissionId("webhooks.read")],
      }
    );
    expect(set.status).toBe(HTTP_STATUS.OK);
    const target = await createTestUser();
    const grant = await call(
      "PUT",
      `/v1/admin/users/${target.id}/roles`,
      token,
      {
        roleIds: [role.id],
      }
    );
    expect(grant.status).toBe(HTTP_STATUS.OK);
  });
});

describe("taking power away needs the target's permissions", () => {
  let callerToken: string;

  beforeAll(async () => {
    callerToken = await getTestPrincipalToken({
      permissions: ["users.write", "users.delete"],
    });
  });

  const userWith = async (permissions: string[]) => {
    const user = await createTestUser();
    const role = await roleWith(permissions);
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id },
    });
    return { user, role };
  };

  it("refuses deactivating a stronger user", async () => {
    const { user } = await userWith(["roles.write"]);
    const res = await call("PATCH", `/v1/admin/users/${user.id}`, callerToken, {
      isActive: false,
    });
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(res.body.error_description).toContain("roles.write");
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).isActive
    ).toBe(true);
  });

  it("refuses removing roles from a stronger user", async () => {
    const { user, role } = await userWith(["roles.write"]);
    const res = await call(
      "PUT",
      `/v1/admin/users/${user.id}/roles`,
      callerToken,
      {
        roleIds: [],
      }
    );
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(
      await prisma.userRole.count({
        where: { userId: user.id, roleId: role.id },
      })
    ).toBe(1);
  });

  it("counts the target's org-scoped roles too", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    await addTestOrgMember(adminToken, org.id, user.id);
    const orgRole = await roleWith(["webhooks.read"]);
    await prisma.userRole.create({
      data: { userId: user.id, roleId: orgRole.id, organizationId: org.id },
    });
    const res = await call(
      "DELETE",
      `/v1/admin/users/${user.id}/sessions/all`,
      callerToken
    );
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(res.body.error_description).toContain("webhooks.read");
  });

  it("refuses ending all sessions of a stronger user", async () => {
    const { user } = await userWith(["roles.write"]);
    const res = await call(
      "DELETE",
      `/v1/admin/users/${user.id}/sessions/all`,
      callerToken
    );
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  const sessionOf = async (
    user: Awaited<ReturnType<typeof createTestUser>>
  ) => {
    await getUiAccessTokenForUser(user);
    const session = await prisma.refreshToken.findFirstOrThrow({
      where: { userId: user.id, revokedAt: null },
    });
    return session.id;
  };

  it("refuses ending one session of a stronger user", async () => {
    const { user } = await userWith(["roles.write"]);
    const sessionId = await sessionOf(user);
    const res = await call(
      "DELETE",
      `/v1/admin/users/${user.id}/sessions`,
      callerToken,
      { sessionId }
    );
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(res.body.error_description).toContain("roles.write");
    expect(
      (
        await prisma.refreshToken.findUniqueOrThrow({
          where: { id: sessionId },
        })
      ).revokedAt
    ).toBeNull();
  });

  it("allows ending one session of a weaker user", async () => {
    const { user } = await userWith(["users.read"]);
    const sessionId = await sessionOf(user);
    const res = await call(
      "DELETE",
      `/v1/admin/users/${user.id}/sessions`,
      callerToken,
      { sessionId }
    );
    expect(res.status).toBe(HTTP_STATUS.NO_CONTENT);
  });

  describe("DELETE /admin/roles/:id/users/:userId", () => {
    const remove = (
      token: string,
      roleId: string,
      userId: string,
      organizationId?: string
    ) =>
      call(
        "DELETE",
        `/v1/admin/roles/${roleId}/users/${userId}${
          organizationId ? `?organizationId=${organizationId}` : ""
        }`,
        token
      );

    it("refuses removing a global role from a stronger user", async () => {
      const rolesOnly = await getTestPrincipalToken({
        permissions: ["roles.delete"],
      });
      const { user, role } = await userWith(["webhooks.write"]);
      const res = await remove(rolesOnly, role.id, user.id);
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(res.body.error_description).toContain("webhooks.write");
      expect(
        await prisma.userRole.count({
          where: { userId: user.id, roleId: role.id },
        })
      ).toBe(1);
    });

    it("refuses removing core's admin role from an administrator", async () => {
      const rolesOnly = await getTestPrincipalToken({
        permissions: ["roles.delete"],
      });
      const adminRole = await prisma.role.findFirstOrThrow({
        where: { name: "admin", serviceId: CORE_SERVICE_ID },
      });
      const user = await createTestUser();
      await prisma.userRole.create({
        data: { userId: user.id, roleId: adminRole.id },
      });
      expect((await remove(rolesOnly, adminRole.id, user.id)).status).toBe(
        HTTP_STATUS.FORBIDDEN
      );
    });

    it("allows removing a global role from a weaker user", async () => {
      const caller = await getTestPrincipalToken({
        permissions: ["roles.delete", "users.read"],
      });
      const { user, role } = await userWith(["users.read"]);
      expect((await remove(caller, role.id, user.id)).status).toBe(
        HTTP_STATUS.NO_CONTENT
      );
    });

    it("refuses an org admin removing an owner's org-scoped role", async () => {
      const org = await createTestOrganization(adminToken);
      const owner = await createTestUser();
      await addTestOrgMember(adminToken, org.id, owner.id, "owner");
      const member = await createTestUser();
      await addTestOrgMember(adminToken, org.id, member.id);
      const role = await roleWith([]);
      await prisma.userRole.createMany({
        data: [owner.id, member.id].map((userId) => ({
          userId,
          roleId: role.id,
          organizationId: org.id,
        })),
      });
      const orgAdmin = await createTestUser();
      await addTestOrgMember(adminToken, org.id, orgAdmin.id, "admin");
      const token = await getTestPrincipalToken({
        userId: orgAdmin.id,
        permissions: ["roles.delete"],
      });

      const res = await remove(token, role.id, owner.id, org.id);
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(
        await prisma.userRole.count({
          where: { userId: owner.id, roleId: role.id },
        })
      ).toBe(1);
      expect((await remove(token, role.id, member.id, org.id)).status).toBe(
        HTTP_STATUS.NO_CONTENT
      );
    });
  });

  describe("changing a role takes from every holder", () => {
    let rolesWrite: string;
    let rolesDelete: string;

    beforeAll(async () => {
      rolesWrite = await getTestPrincipalToken({
        permissions: ["roles.write"],
      });
      rolesDelete = await getTestPrincipalToken({
        permissions: ["roles.delete"],
      });
    });

    it("refuses deleting a role granting what the caller lacks", async () => {
      const { user, role } = await userWith(["webhooks.write"]);
      const res = await call(
        "DELETE",
        `/v1/admin/roles/${role.id}`,
        rolesDelete
      );
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(res.body.error_description).toContain("webhooks.write");
      expect(
        await prisma.userRole.count({
          where: { userId: user.id, roleId: role.id },
        })
      ).toBe(1);
    });

    it("refuses deleting a custom role through which a user holds admin", async () => {
      const { role } = await userWith(["admin"]);
      const res = await call(
        "DELETE",
        `/v1/admin/roles/${role.id}`,
        rolesDelete
      );
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(await prisma.role.count({ where: { id: role.id } })).toBe(1);
    });

    it("deletes a role whose permissions the caller holds", async () => {
      const caller = await getTestPrincipalToken({
        permissions: ["roles.delete", "users.read"],
      });
      const { role } = await userWith(["users.read"]);
      const res = await call("DELETE", `/v1/admin/roles/${role.id}`, caller);
      expect(res.status).toBe(HTTP_STATUS.NO_CONTENT);
    });

    it("refuses deactivating a role granting what the caller lacks", async () => {
      const { role } = await userWith(["admin"]);
      const res = await call(
        "PATCH",
        `/v1/admin/roles/${role.id}`,
        rolesWrite,
        {
          isActive: false,
        }
      );
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(
        (await prisma.role.findUniqueOrThrow({ where: { id: role.id } }))
          .isActive
      ).toBe(true);
    });

    it("deactivates a role whose permissions the caller holds", async () => {
      const { role } = await userWith(["roles.read"]);
      const res = await call(
        "PATCH",
        `/v1/admin/roles/${role.id}`,
        rolesWrite,
        {
          isActive: false,
        }
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
    });

    it("refuses dropping a permission the caller lacks from a role", async () => {
      const { role } = await userWith(["admin"]);
      const res = await call(
        "PUT",
        `/v1/admin/roles/${role.id}/permissions`,
        rolesWrite,
        { permissionIds: [] }
      );
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(res.body.error_description).toContain("admin");
      expect(
        await prisma.rolePermission.count({ where: { roleId: role.id } })
      ).toBe(1);
    });

    it("drops a permission the caller holds and keeps one it lacks", async () => {
      const { role } = await userWith(["settings.write", "roles.read"]);
      const res = await call(
        "PUT",
        `/v1/admin/roles/${role.id}/permissions`,
        rolesWrite,
        { permissionIds: [await permissionId("settings.write")] }
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
    });
  });

  it("allows all three against a weaker user", async () => {
    const { user } = await userWith(["users.read"]);
    expect(
      (
        await call(
          "DELETE",
          `/v1/admin/users/${user.id}/sessions/all`,
          callerToken
        )
      ).status
    ).toBe(HTTP_STATUS.OK);
    expect(
      (
        await call("PUT", `/v1/admin/users/${user.id}/roles`, callerToken, {
          roleIds: [],
        })
      ).status
    ).toBe(HTTP_STATUS.OK);
    const weaker = await userWith(["users.read"]);
    expect(
      (
        await call("PATCH", `/v1/admin/users/${weaker.user.id}`, callerToken, {
          isActive: false,
        })
      ).status
    ).toBe(HTTP_STATUS.OK);
  });

  it("lets admin act on anyone", async () => {
    const { user } = await userWith(["roles.write"]);
    const res = await call("PATCH", `/v1/admin/users/${user.id}`, adminToken, {
      isActive: false,
    });
    expect(res.status).toBe(HTTP_STATUS.OK);
  });
});
