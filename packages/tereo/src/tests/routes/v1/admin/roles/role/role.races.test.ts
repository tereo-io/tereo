// @module-tag int
// @module-tag auth
// @module-tag race
import { holdLocks, waitForLockWait } from "../../../../../support/dbLocks.js";
import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { createTestClient } from "../../../../../support/auth/clients.js";
import { createTestRole } from "../../../../../support/auth/users.js";
import { BASE_URL } from "../../../../../support/auth/constants.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";

const call = (method: string, path: string, token: string, body?: unknown) =>
  fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Resolves once some backend waits on a lock in a query matching `like`. */
type Table = "organizations" | "roles";

/**
 * Locks the row, starts `request`, and once its write waits on the lock,
 * applies `change` and commits.
 */
const whileLocked = async (
  table: Table,
  id: string,
  request: () => Promise<Response>,
  change: (
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
  ) => Promise<unknown>
) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  const holder = prisma.$transaction(
    async (tx) => {
      if (table === "organizations") {
        await tx.$queryRaw`SELECT id FROM "auth"."organizations" WHERE id = ${id}::uuid FOR UPDATE`;
      } else {
        await tx.$queryRaw`SELECT id FROM "auth"."roles" WHERE id = ${id}::uuid FOR UPDATE`;
      }
      locked();
      await gate;
      await change(tx);
    },
    { timeout: 30_000 }
  );
  await isLocked;
  const pending = request();
  await waitForLockWait(`%UPDATE%"auth"."${table}"%`);
  release();
  await holder;
  return await pending;
};

let adminToken: string;

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({ permissions: ["admin"] });
});

/**
 * Archiving needs the row inactive; a PATCH may reactivate it only while it
 * is not archived. Each case holds the row lock so one side passes its check
 * and then waits on its write while the other side commits.
 */

describe("PATCH /v1/admin/roles/:id and POST /v1/admin/roles/:id/archive", () => {
  const inactiveRole = async () => {
    const role = await createTestRole();
    await prisma.role.update({
      where: { id: role.id },
      data: { isActive: false },
    });
    return role.id;
  };

  it("a reactivation that waited on an archive does not leave it archived and active", async () => {
    const id = await inactiveRole();
    const res = await whileLocked(
      "roles",
      id,
      () =>
        call("PATCH", `/v1/admin/roles/${id}`, adminToken, { isActive: true }),
      (tx) =>
        tx.role.update({ where: { id }, data: { archivedAt: new Date() } })
    );
    const row = await prisma.role.findUniqueOrThrow({ where: { id } });
    expect(row.archivedAt).not.toBeNull();
    expect(row.isActive).toBe(false);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("resource_archived");
  });

  it("an archive that waited on a reactivation is refused", async () => {
    const id = await inactiveRole();
    const res = await whileLocked(
      "roles",
      id,
      () => call("POST", `/v1/admin/roles/${id}/archive`, adminToken),
      (tx) => tx.role.update({ where: { id }, data: { isActive: true } })
    );
    const row = await prisma.role.findUniqueOrThrow({ where: { id } });
    expect(row.archivedAt).toBeNull();
    expect(row.isActive).toBe(true);
    expect(res.status).toBe(409);
  });
});

describe("PATCH /v1/admin/roles/:id deactivating", () => {
  it("runs the admin guard though the role read inactive before a reactivation committed", async () => {
    // The guard decides whether the role still counts under its lock; the
    // read before the transaction may predate the reactivation.
    const role = await createTestRole();
    await prisma.role.update({
      where: { id: role.id },
      data: { isActive: false },
    });
    const release = await holdLocks(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('core:admin-remains', 0))`;
      await tx.role.update({
        where: { id: role.id },
        data: { isActive: true },
      });
    });
    const pending = call("PATCH", `/v1/admin/roles/${role.id}`, adminToken, {
      isActive: false,
    });
    try {
      await waitForLockWait("%core:admin-remains%", 5_000);
    } finally {
      await release();
    }
    expect((await pending).status).toBe(200);
    const row = await prisma.role.findUniqueOrThrow({ where: { id: role.id } });
    expect(row.isActive).toBe(false);
  });
});

describe("PATCH /v1/admin/roles/:id deactivating a role reactivated meanwhile", () => {
  it("revokes its service clients' tokens, read as active under the row lock", async () => {
    const client = await createTestClient({
      clientType: "confidential",
      grantTypes: ["client_credentials"],
    });
    const account = await prisma.user.findFirstOrThrow({
      where: { oauthClientId: client.id },
    });
    const role = await createTestRole();
    await prisma.role.update({
      where: { id: role.id },
      data: { isActive: false },
    });
    await prisma.userRole.create({
      data: { userId: account.id, roleId: role.id },
    });
    const token = await prisma.accessToken.create({
      data: {
        jti: crypto.randomUUID(),
        clientId: client.id,
        userId: account.id,
        scopes: [],
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });

    const release = await holdLocks(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "auth"."roles" WHERE id = ${role.id}::uuid FOR UPDATE`;
      await tx.role.update({
        where: { id: role.id },
        data: { isActive: true },
      });
    });
    const pending = call("PATCH", `/v1/admin/roles/${role.id}`, adminToken, {
      isActive: false,
    });
    try {
      await waitForLockWait(`%"auth"."roles"%`);
    } finally {
      await release();
    }
    expect((await pending).status).toBe(200);
    const row = await prisma.accessToken.findUniqueOrThrow({
      where: { id: token.id },
    });
    expect(row.revokedAt).not.toBeNull();
  });
});

/**
 * Replacing permissions without `admin` takes the admin guard's advisory lock,
 * then the role row. A user-role insert share-locks that row, and
 * setUserRoles holds the advisory lock first, so the PUT must queue on the
 * advisory lock before touching the row, or the two deadlock.
 */
describe("PUT /v1/admin/roles/:id/permissions and a concurrent user-role assignment", () => {
  it("queues on the admin guard without holding the role row, so no deadlock", async () => {
    const role = await createTestRole();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const isHeld = new Promise<void>((r) => (held = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('core:admin-remains', 0))`;
        held();
        await gate;
        // What a user-role insert's foreign key does to the role row.
        await tx.$queryRaw`SELECT 1 FROM "auth"."roles" WHERE id = ${role.id}::uuid FOR KEY SHARE`;
      },
      { timeout: 30_000 }
    );
    await isHeld;
    const pending = call(
      "PUT",
      `/v1/admin/roles/${role.id}/permissions`,
      adminToken,
      { permissionIds: [] }
    );
    await waitForLockWait("%pg_advisory_xact_lock%");
    release();
    await holder;
    expect((await pending).status).toBe(200);
  });
});
