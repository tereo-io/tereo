import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestPrincipalToken } from "../support/principals.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestUser,
  generateUniqueId,
} from "../support/auth.js";

/**
 * The last-admin guard. Other suites leave admins behind, so this file sets
 * their global `admin` assignments aside (expired) for its duration and
 * restores them afterwards; the users made here are then the only admins.
 */
describe("Last active administrator", () => {
  const setAside = new Map<string, Date | null>();
  let callerToken: string;
  let adminPermissionId: string;

  const adminAssignments = () =>
    prisma.userRole.findMany({
      where: {
        organizationId: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        user: { isActive: true, userType: "human" },
        role: {
          isActive: true,
          archivedAt: null,
          retiredAt: null,
          rolePermissions: {
            some: { permission: { name: "admin", retiredAt: null } },
          },
        },
      },
    });

  const adminRole = async () =>
    prisma.role.create({
      data: {
        name: `guard-admin-${generateUniqueId()}`,
        displayName: "Guard test admin",
        rolePermissions: { create: [{ permissionId: adminPermissionId }] },
      },
    });

  const makeAdmin = async () => {
    const user = await createTestUser();
    const role = await adminRole();
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id },
    });
    return { user, role };
  };

  beforeAll(async () => {
    adminPermissionId = (
      await prisma.permission.findUniqueOrThrow({ where: { name: "admin" } })
    ).id;
    // Holds admin, since stripping an admin's roles needs every permission
    // they hold, but as a service account: it is not an administrator the
    // guard counts.
    const callerId = randomUUID();
    callerToken = await getTestPrincipalToken({
      userId: callerId,
      permissions: ["admin"],
    });
    await prisma.user.update({
      where: { id: callerId },
      data: { userType: "service_account" },
    });
    for (const a of await adminAssignments()) {
      setAside.set(a.id, a.expiresAt);
      await prisma.userRole.update({
        where: { id: a.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
    }
  });

  afterAll(async () => {
    for (const [id, expiresAt] of setAside) {
      await prisma.userRole.updateMany({ where: { id }, data: { expiresAt } });
    }
  });

  const removeAllRoles = (userId: string) =>
    fetch(`${BASE_URL}/v1/admin/users/${userId}/roles`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${callerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ roleIds: [] }),
    });

  it("two concurrent removals of the last two admins: one is refused", async () => {
    const x = await makeAdmin();
    const y = await makeAdmin();

    const responses = await Promise.all([
      removeAllRoles(x.user.id),
      removeAllRoles(y.user.id),
    ]);
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([HTTP_STATUS.OK, HTTP_STATUS.CONFLICT]);
    expect((await adminAssignments()).length).toBe(1);

    // Leave the remaining one for the next test to find on its own.
    await prisma.userRole.deleteMany({
      where: { userId: { in: [x.user.id, y.user.id] } },
    });
  });

  it("keeping only an expired admin assignment counts as removing admin", async () => {
    const { user } = await makeAdmin();
    const expired = await adminRole();
    await prisma.userRole.create({
      data: {
        userId: user.id,
        roleId: expired.id,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    const res = await fetch(`${BASE_URL}/v1/admin/users/${user.id}/roles`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${callerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ roleIds: [expired.id] }),
    });
    expect(res.status).toBe(HTTP_STATUS.CONFLICT);
    expect((await adminAssignments()).length).toBe(1);

    await prisma.userRole.deleteMany({ where: { userId: user.id } });
  });

  it("deleting the last admin role is refused before any token is revoked", async () => {
    const { role } = await makeAdmin();

    // A service account holds the role too; its tokens would be revoked
    // with the delete.
    const owner = await createTestUser();
    const client = await prisma.oAuthClient.create({
      data: {
        clientId: `guard-${generateUniqueId()}`,
        name: "Guard test client",
        redirectUris: [],
        scopes: [],
        grantTypes: ["client_credentials"],
        ownerId: owner.id,
      },
    });
    const account = await prisma.user.create({
      data: {
        email: `guard-${generateUniqueId()}@services.example.com`,
        passwordHash: "!",
        userType: "service_account",
        oauthClientId: client.id,
      },
    });
    await prisma.userRole.create({
      data: { userId: account.id, roleId: role.id },
    });
    const jti = randomUUID();
    await prisma.accessToken.create({
      data: {
        jti,
        clientId: client.id,
        userId: account.id,
        scopes: [],
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    const response = await fetch(`${BASE_URL}/v1/admin/roles/${role.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${callerToken}` },
    });
    expect(response.status).toBe(HTTP_STATUS.CONFLICT);

    const token = await prisma.accessToken.findUniqueOrThrow({
      where: { jti },
    });
    expect(token.revokedAt).toBeNull();
    expect(await prisma.role.findUnique({ where: { id: role.id } })).not.toBe(
      null
    );

    await prisma.userRole.deleteMany({ where: { roleId: role.id } });
  });
});
