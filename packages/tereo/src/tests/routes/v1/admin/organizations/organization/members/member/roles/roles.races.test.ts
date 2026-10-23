// @module-tag int
// @module-tag auth
// @module-tag race

import { getTestPrincipalToken } from "../../../../../../../../support/principals.js";
import { BASE_URL } from "../../../../../../../../support/auth/constants.js";
import { prisma } from "../../../../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  addTestOrgMember,
  createTestOrganization,
} from "../../../../../../../../support/auth/organizations.js";
import {
  createTestRole,
  createTestUser,
} from "../../../../../../../../support/auth/users.js";

const ITERATIONS = 60;

const call = (method: string, path: string, token: string, body?: unknown) =>
  fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Alternates which side starts late, over a range of offsets. */
const race = <A, B>(i: number, a: () => Promise<A>, b: () => Promise<B>) => {
  const offset = i % 20;
  return Promise.all([
    sleep(i % 2 === 0 ? offset : 0).then(a),
    sleep(i % 2 === 0 ? 0 : offset).then(b),
  ]);
};

const roleGranting = async (permission: string) => {
  const role = await createTestRole();
  const { id: permissionId } = await prisma.permission.findUniqueOrThrow({
    where: { name: permission },
  });
  await prisma.rolePermission.create({
    data: { roleId: role.id, permissionId },
  });
  return role;
};

let adminToken: string;

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({ permissions: ["admin"] });
});

describe("PUT /v1/admin/organizations/:id/members/:userId/roles", () => {
  it("is not put back by an org admin who could not grant it, in an organization", async () => {
    const org = await createTestOrganization(adminToken);
    const orgAdmin = await createTestUser();
    await addTestOrgMember(adminToken, org.id, orgAdmin.id, "admin");
    const orgAdminToken = await getTestPrincipalToken({
      userId: orgAdmin.id,
      permissions: [],
    });
    const role = await roleGranting("webhooks.write");
    const user = await createTestUser();
    await addTestOrgMember(adminToken, org.id, user.id);
    const scoped = { userId: user.id, roleId: role.id, organizationId: org.id };

    let regranted = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      await prisma.userRole.deleteMany({ where: { userId: user.id } });
      await prisma.userRole.create({ data: scoped });
      const [byOrgAdmin, byAdmin] = await race(
        i,
        () =>
          call(
            "PUT",
            `/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
            orgAdminToken,
            { roleIds: [role.id] }
          ),
        () =>
          call(
            "DELETE",
            `/v1/admin/roles/${role.id}/users/${user.id}?organizationId=${org.id}`,
            adminToken
          )
      );
      const after = await prisma.userRole.count({ where: scoped });
      if (byOrgAdmin.status === 200 && byAdmin.status === 204 && after === 1) {
        regranted++;
      }
    }
    expect(regranted).toBe(0);
  }, 120_000);
});
