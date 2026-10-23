// @module-tag int
// @module-tag auth
// @module-tag race
import { ensureDefaultOrganization } from "../../../../../../utils/defaultOrganization.js";
import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { type AuthContext } from "../../../../../../middleware/auth.js";
import { waitForLockWait } from "../../../../../support/dbLocks.js";
import { BASE_URL } from "../../../../../support/auth/constants.js";
import { ForbiddenError } from "../../../../../../utils/errors.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { type Request, type Response } from "express";
import db from "../../../../../../utils/db/index.js";
import { randomUUID } from "crypto";
import {
  setUserRoles,
  updateUser,
} from "../../../../../../routes/v1/admin/users/user/controllers.js";
import {
  createTestRole,
  createTestUser,
} from "../../../../../support/auth/users.js";

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

/** Resolves once some backend waits on a lock in a query matching `like`. */
let adminToken: string;

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({ permissions: ["admin"] });
});

describe("PUT /v1/admin/users/:id/roles", () => {
  it("is not put back by a caller who could not grant it, globally", async () => {
    const callerToken = await getTestPrincipalToken({
      permissions: ["users.write"],
    });
    const role = await roleGranting("webhooks.write");
    const user = await createTestUser();

    let regranted = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      await prisma.userRole.deleteMany({ where: { userId: user.id } });
      await prisma.userRole.create({
        data: { userId: user.id, roleId: role.id },
      });
      const [byCaller, byAdmin] = await race(
        i,
        () =>
          call("PUT", `/v1/admin/users/${user.id}/roles`, callerToken, {
            roleIds: [role.id],
          }),
        () =>
          call(
            "DELETE",
            `/v1/admin/roles/${role.id}/users/${user.id}`,
            adminToken
          )
      );
      const after = await prisma.userRole.count({
        where: { userId: user.id, roleId: role.id },
      });
      if (byCaller.status === 200 && byAdmin.status === 204 && after === 1) {
        regranted++;
      }
    }
    expect(regranted).toBe(0);
  }, 120_000);

  it("answers 409, not 500, when the assignment's foreign key fails", async () => {
    const role = await createTestRole();
    const user = await createTestUser();

    // Holding the role row stops the assignment's foreign-key check, after
    // the request has read the role, until the role is gone.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "auth"."roles" WHERE id = ${role.id}::uuid FOR UPDATE`;
        locked();
        await gate;
        await tx.role.delete({ where: { id: role.id } });
      },
      { timeout: 30_000 }
    );
    await isLocked;

    const pending = fetch(`${BASE_URL}/v1/admin/users/${user.id}/roles`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ roleIds: [role.id] }),
    });
    await waitForLockWait(`%INSERT%"auth"."user_roles"%`);
    release();
    await holder;

    const res = await pending;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("conflict");
    expect(await prisma.userRole.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe("PUT /v1/admin/users/:id/roles and PATCH /v1/admin/users/:id", () => {
  beforeAll(async () => {
    await ensureDefaultOrganization();
  });

  const authAs = (userId: string, email: string): AuthContext => ({
    userId,
    email,
    name: null,
    userType: "human",
    permissions: [],
    currentSessionId: null,
    jti: randomUUID(),
    clientId: "test",
    oauthClientId: null,
    organizationId: null,
    authTime: null,
  });

  const fakeRes = () => {
    const res = { status: vi.fn(), json: vi.fn(), send: vi.fn() };
    res.status.mockReturnValue(res);
    return res as unknown as Response;
  };

  /** Resolves once a session of this database waits on a lock. */
  const someoneWaits = async (done: () => boolean) => {
    while (!done()) {
      const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND datname = current_database()`;
      if (waiting > 0) return;
      await new Promise((r) => setImmediate(r));
    }
  };

  it("is refused once a stronger role has been granted", async () => {
    const adminId = randomUUID();
    await getTestPrincipalToken({ userId: adminId, permissions: ["admin"] });
    const resetterId = randomUUID();
    await getTestPrincipalToken({
      userId: resetterId,
      permissions: ["users.write"],
    });
    const role = await roleGranting("webhooks.write");
    const target = await createTestUser();

    // The grant pauses after writing, its transaction still open.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let granted!: () => void;
    const written = new Promise<void>((r) => (granted = r));
    const original = db.roles.setUserRoles;
    const spy = vi
      .spyOn(db.roles, "setUserRoles")
      .mockImplementation(async (...args) => {
        const result = await original(...args);
        granted();
        await gate;
        return result;
      });

    try {
      const grant = setUserRoles(
        {
          auth: authAs(adminId, "admin@test.local"),
          params: { id: target.id },
          body: { roleIds: [role.id] },
        } as unknown as Request,
        fakeRes()
      );
      await written;

      let settled = false;
      const reset = updateUser(
        {
          auth: authAs(resetterId, "resetter@test.local"),
          params: { id: target.id },
          body: { password: "AnotherPassword456!" },
        } as unknown as Request,
        fakeRes()
      ).then(
        () => "reset" as const,
        (err: unknown) => err
      );
      void reset.then(() => (settled = true));
      await Promise.race([reset, someoneWaits(() => settled)]);
      release();
      await grant;

      expect(await reset).toBeInstanceOf(ForbiddenError);
    } finally {
      release();
      spy.mockRestore();
    }
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(stored.passwordHash).toBe(target.passwordHash);
  });
});
