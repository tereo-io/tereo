// @module-tag int
// @module-tag auth
import { createTestRole, createTestUser } from "../../support/auth/users.js";
import { BASE_URL, HTTP_STATUS } from "../../support/auth/constants.js";
import { getUiAccessTokenForUser } from "../../support/auth/login.js";
import { getTestPrincipalToken } from "../../support/principals.js";
import { CORE_SERVICE_ID } from "../../../definitions/index.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { fetchJson } from "../../support/http.js";
import {
  addTestOrgMember,
  createTestOrganization,
} from "../../support/auth/organizations.js";

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
