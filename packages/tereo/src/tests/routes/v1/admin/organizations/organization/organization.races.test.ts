// @module-tag int
// @module-tag auth
// @module-tag race
import { createTestOrganization } from "../../../../../support/auth/organizations.js";
import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { waitForLockWait } from "../../../../../support/dbLocks.js";
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

describe("PATCH /v1/admin/organizations/:id and POST /v1/admin/organizations/:id/archive", () => {
  const inactiveOrg = async () => {
    const org = await createTestOrganization(adminToken);
    const off = await call(
      "PATCH",
      `/v1/admin/organizations/${org.id}`,
      adminToken,
      {
        isActive: false,
      }
    );
    expect(off.status).toBe(200);
    return org.id;
  };

  it("a reactivation that waited on an archive does not leave it archived and active", async () => {
    const id = await inactiveOrg();
    const res = await whileLocked(
      "organizations",
      id,
      () =>
        call("PATCH", `/v1/admin/organizations/${id}`, adminToken, {
          isActive: true,
        }),
      (tx) =>
        tx.organization.update({
          where: { id },
          data: { archivedAt: new Date() },
        })
    );
    const row = await prisma.organization.findUniqueOrThrow({ where: { id } });
    expect(row.archivedAt).not.toBeNull();
    expect(row.isActive).toBe(false);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("resource_archived");
  });

  it("an archive that waited on a reactivation is refused", async () => {
    const id = await inactiveOrg();
    const res = await whileLocked(
      "organizations",
      id,
      () => call("POST", `/v1/admin/organizations/${id}/archive`, adminToken),
      (tx) =>
        tx.organization.update({ where: { id }, data: { isActive: true } })
    );
    const row = await prisma.organization.findUniqueOrThrow({ where: { id } });
    expect(row.archivedAt).toBeNull();
    expect(row.isActive).toBe(true);
    expect(res.status).toBe(409);
  });
});
