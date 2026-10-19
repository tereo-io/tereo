import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { getTestPrincipalToken } from "../utils/principals.js";
import { describe, it, expect, beforeAll, vi } from "vitest";
import type { AuthContext } from "../../middleware/auth.js";
import { ForbiddenError } from "../../utils/errors.js";
import { prisma } from "../../utils/db/prisma.js";
import type { Request, Response } from "express";
import db from "../../utils/db/index.js";
import { randomUUID } from "crypto";
import {
  setUserRoles,
  updateUser,
} from "../../routes/v1/admin/users/user/controllers.js";
import {
  BASE_URL,
  addTestOrgMember,
  createTestOrganization,
  createTestRole,
  createTestUser,
} from "./utils/test-helpers.js";

/**
 * Checks that depend on what the target holds or is must see it as of the
 * write, not as of a read made before a concurrent change. Each case loops
 * over a range of offsets between the two requests.
 */

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

describe("a held role removed while PUT …/roles keeps it", () => {
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

describe("an org admin racing a promotion to owner", () => {
  const setup = async () => {
    const org = await createTestOrganization(adminToken);
    const owner = await createTestUser();
    await addTestOrgMember(adminToken, org.id, owner.id, "owner");
    const orgAdmin = await createTestUser();
    await addTestOrgMember(adminToken, org.id, orgAdmin.id, "admin");
    const orgAdminToken = await getTestPrincipalToken({
      userId: orgAdmin.id,
      permissions: [],
    });
    const target = await createTestUser();
    return { org, orgAdminToken, target };
  };

  const memberPath = (orgId: string, userId: string) =>
    `/v1/admin/organizations/${orgId}/members/${userId}`;

  it("never changes the tier of someone who is an owner by then", async () => {
    const { org, orgAdminToken, target } = await setup();
    await addTestOrgMember(adminToken, org.id, target.id, "admin");
    const where = {
      organizationId_userId: { organizationId: org.id, userId: target.id },
    };

    let demotedOwner = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      await prisma.organizationMember.update({
        where,
        data: { memberRole: "admin" },
      });
      const [byOrgAdmin, byPlatform] = await race(
        i,
        () =>
          call("PATCH", memberPath(org.id, target.id), orgAdminToken, {
            memberRole: "member",
          }),
        () =>
          call("PATCH", memberPath(org.id, target.id), adminToken, {
            memberRole: "owner",
          })
      );
      const final = await prisma.organizationMember.findUniqueOrThrow({
        where,
      });
      if (
        byOrgAdmin.status === 200 &&
        byPlatform.status === 200 &&
        final.memberRole === "member"
      ) {
        demotedOwner++;
      }
    }
    expect(demotedOwner).toBe(0);
  }, 120_000);

  it("never removes someone who is an owner by then", async () => {
    const { org, orgAdminToken, target } = await setup();

    let removedOwner = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      await prisma.organizationMember.deleteMany({
        where: { organizationId: org.id, userId: target.id },
      });
      await prisma.organizationMember.create({
        data: {
          organizationId: org.id,
          userId: target.id,
          memberRole: "admin",
        },
      });
      const [byOrgAdmin, byPlatform] = await race(
        i,
        () => call("DELETE", memberPath(org.id, target.id), orgAdminToken),
        () =>
          call("PATCH", memberPath(org.id, target.id), adminToken, {
            memberRole: "owner",
          })
      );
      // The promotion found the membership, so it came first: the removal
      // that followed took an owner.
      if (byOrgAdmin.status === 204 && byPlatform.status === 200) {
        removedOwner++;
      }
    }
    expect(removedOwner).toBe(0);
  }, 120_000);
});

describe("a credential reset racing a grant to its target", () => {
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
