// @module-tag int
// @module-tag auth

import { getAccessTokenForUser } from "../../../../../support/auth/login.js";
import { createTestClient } from "../../../../../support/auth/clients.js";
import { SYSTEM_USER_ID } from "../../../../../../definitions/index.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createTestOrganization,
  addTestOrgMember,
} from "../../../../../support/auth/organizations.js";
import {
  BASE_URL,
  HTTP_STATUS,
} from "../../../../../support/auth/constants.js";
import {
  createTestUser,
  createAdminUser,
  createTestRole,
} from "../../../../../support/auth/users.js";

interface UserRolesResponse {
  userId: string;
  roles: Array<{
    id: string;
    name: string;
    displayName: string;
    expiresAt: string | null;
  }>;
}

interface ErrorResponse {
  error?: string;
  error_description?: string;
  message?: string;
  [key: string]: unknown;
}

let regularUser: Awaited<ReturnType<typeof createTestUser>>;
let adminToken: string;

beforeAll(async () => {
  const testClient = await createTestClient();
  const adminUser = await createAdminUser();
  regularUser = await createTestUser();
  adminToken = await getAccessTokenForUser(adminUser, testClient);
});

describe("PUT /v1/admin/users/:id/roles", () => {
  it("should set user roles", async () => {
    const role = await createTestRole();
    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${regularUser.id}/roles`,
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
    const body = (await response.json()) as UserRolesResponse;
    expect(body.roles.map((r) => r.id)).toEqual([role.id]);
  });

  it("returns 400 unknown_role for a role id that names no assignable role", async () => {
    const archived = await createTestRole();
    await prisma.role.update({
      where: { id: archived.id },
      data: { isActive: false, archivedAt: new Date() },
    });
    for (const roleId of [randomUUID(), archived.id]) {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${regularUser.id}/roles`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ roleIds: [roleId] }),
        }
      );
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBe("unknown_role");
    }
  });

  it("keeps org-scoped assignments and lists only global roles", async () => {
    const user = await createTestUser();
    const org = await createTestOrganization(adminToken);
    await addTestOrgMember(adminToken, org.id, user.id);
    const orgRole = await createTestRole();
    const globalRole = await createTestRole();
    const headers = {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    };

    const orgPut = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ roleIds: [orgRole.id] }),
      }
    );
    expect(orgPut.status).toBe(HTTP_STATUS.OK);

    const put = await fetch(`${BASE_URL}/v1/admin/users/${user.id}/roles`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ roleIds: [globalRole.id, globalRole.id] }),
    });
    expect(put.status).toBe(HTTP_STATUS.OK);
    const putData = (await put.json()) as UserRolesResponse;
    expect(putData.roles.map((r) => r.id)).toEqual([globalRole.id]);

    const assignments = await prisma.userRole.findMany({
      where: { userId: user.id },
    });
    expect(assignments.map((a) => [a.roleId, a.organizationId]).sort()).toEqual(
      [
        [globalRole.id, null],
        [orgRole.id, org.id],
      ].sort()
    );

    const get = await fetch(`${BASE_URL}/v1/admin/users/${user.id}/roles`, {
      headers,
    });
    const getData = (await get.json()) as UserRolesResponse;
    expect(getData.roles.map((r) => r.id)).toEqual([globalRole.id]);

    const orgGet = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
      { headers }
    );
    const orgData = (await orgGet.json()) as UserRolesResponse;
    expect(orgData.roles.map((r) => r.id)).toEqual([orgRole.id]);
  });

  it("keeps the expiry of an assignment that stays, globally and per organization", async () => {
    const user = await createTestUser();
    const org = await createTestOrganization(adminToken);
    await addTestOrgMember(adminToken, org.id, user.id);
    const [kept, dropped, added] = await Promise.all([
      createTestRole(),
      createTestRole(),
      createTestRole(),
    ]);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    for (const organizationId of [null, org.id]) {
      await prisma.userRole.createMany({
        data: [
          { userId: user.id, roleId: kept.id, organizationId, expiresAt },
          { userId: user.id, roleId: dropped.id, organizationId },
        ],
      });
    }
    const headers = {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    };
    const roleIds = [kept.id, added.id];

    const put = await fetch(`${BASE_URL}/v1/admin/users/${user.id}/roles`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ roleIds }),
    });
    expect(put.status).toBe(HTTP_STATUS.OK);
    const orgPut = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
      { method: "PUT", headers, body: JSON.stringify({ roleIds }) }
    );
    expect(orgPut.status).toBe(HTTP_STATUS.OK);

    for (const res of [put, orgPut]) {
      const { roles } = (await res.json()) as {
        roles: { id: string; expiresAt: string | null }[];
      };
      expect(Object.fromEntries(roles.map((r) => [r.id, r.expiresAt]))).toEqual(
        {
          [kept.id]: expiresAt.toISOString(),
          [added.id]: null,
        }
      );
    }
    expect(
      await prisma.userRole.count({
        where: { userId: user.id, roleId: dropped.id },
      })
    ).toBe(0);
  });
  it("keeps a held archived or retired role sent back from GET, globally and per organization", async () => {
    const user = await createTestUser();
    const org = await createTestOrganization(adminToken);
    await addTestOrgMember(adminToken, org.id, user.id);
    const [archived, retired] = await Promise.all([
      createTestRole(),
      createTestRole(),
    ]);
    for (const organizationId of [null, org.id]) {
      await prisma.userRole.createMany({
        data: [archived.id, retired.id].map((roleId) => ({
          userId: user.id,
          roleId,
          organizationId,
        })),
      });
    }
    await prisma.role.update({
      where: { id: archived.id },
      data: { isActive: false, archivedAt: new Date() },
    });
    await prisma.role.update({
      where: { id: retired.id },
      data: { retiredAt: new Date() },
    });
    const headers = {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    };

    for (const path of [
      `/v1/admin/users/${user.id}/roles`,
      `/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
    ]) {
      const got = (await (
        await fetch(`${BASE_URL}${path}`, { headers })
      ).json()) as UserRolesResponse;
      const roleIds = got.roles.map((r) => r.id);
      expect(roleIds.sort()).toEqual([archived.id, retired.id].sort());
      const put = await fetch(`${BASE_URL}${path}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ roleIds }),
      });
      expect(put.status).toBe(HTTP_STATUS.OK);
    }
    expect(
      await prisma.userRole.count({
        where: { userId: user.id, roleId: { in: [archived.id, retired.id] } },
      })
    ).toBe(4);
  });

  describe("system user", () => {
    it("cannot be given roles", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${SYSTEM_USER_ID}/roles`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ roleIds: [] }),
        }
      );
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });
});
