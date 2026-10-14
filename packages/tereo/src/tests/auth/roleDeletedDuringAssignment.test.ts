import { getTestPrincipalToken } from "../utils/principals.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import {
  BASE_URL,
  createTestRole,
  createTestUser,
} from "./utils/test-helpers.js";

/** Resolves once some backend waits on a lock in a query matching `like`. */
const waitForLockWait = async (like: string, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query ILIKE ${like}`;
    if (Number(rows[0].n) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`No backend waited on a lock for ${like}`);
};

let adminToken: string;

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({ permissions: ["admin"] });
});

describe("a role deleted while PUT …/roles assigns it", () => {
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
