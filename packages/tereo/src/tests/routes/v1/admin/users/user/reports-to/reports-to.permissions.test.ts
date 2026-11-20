// @module-tag int
// @module-tag auth
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { adminApi } from "../../../../../../support/groups.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../../../../support/principals.js";
import {
  createAdminUser,
  createTestUser,
} from "../../../../../../support/auth/users.js";

const userIds: string[] = [];
let reportsWriter: string;
let admin: string;

const user = async () => {
  const created = await createTestUser();
  userIds.push(created.id);
  return created.id;
};
const adminUser = async () => {
  const created = await createAdminUser();
  userIds.push(created.id);
  return created.id;
};

const put = (id: string, userId: string, token: string) =>
  adminApi("PUT", `/users/${id}/reports-to`, token, { userId });
const del = (id: string, token: string) =>
  adminApi("DELETE", `/users/${id}/reports-to`, token);
const link = (id: string, reportsToId: string) =>
  prisma.user.update({ where: { id }, data: { reportsToId } });

beforeAll(async () => {
  reportsWriter = await getTestPrincipalToken({
    permissions: ["users.reports.write"],
  });
  admin = await getTestPrincipalToken({ permissions: ["admin"] });
});

afterAll(async () => {
  await prisma.user.updateMany({
    where: { id: { in: userIds } },
    data: { reportsToId: null },
  });
});

describe("PUT /v1/admin/users/:id/reports-to", () => {
  it("refuses placing a user holding permissions the caller does not", async () => {
    const [subject, manager] = [await adminUser(), await user()];
    const res = await put(subject, manager, reportsWriter);
    expect(res.status).toBe(403);
    expect(res.body.error_description).toBe(
      "You cannot place under another user a user, or someone reporting to them, holding permissions you do not: admin"
    );
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: subject } }))
        .reportsToId
    ).toBeNull();
  });

  it("refuses placing a user with someone below them holding permissions the caller does not", async () => {
    const [subject, middle, below, manager] = [
      await user(),
      await user(),
      await adminUser(),
      await user(),
    ];
    await link(middle, subject);
    await link(below, middle);
    const res = await put(subject, manager, reportsWriter);
    expect(res.status).toBe(403);
    expect(res.body.error_description).toMatch(/: admin$/);
  });

  it("refuses placing an organization owner without organizations.write", async () => {
    const [subject, manager] = [await user(), await user()];
    const orgId = await ensureTestOrganization("reports-to-owner");
    await prisma.organizationMember.create({
      data: { organizationId: orgId, userId: subject, memberRole: "owner" },
    });
    const res = await put(subject, manager, reportsWriter);
    expect(res.status).toBe(403);
    expect(res.body.error_description).toBe(
      "You cannot place under another user an organization owner or admin, or someone reporting to them, without organizations.write"
    );
  });

  it("allows placing a user who, with everyone below them, holds nothing", async () => {
    const [subject, below, manager] = [
      await user(),
      await user(),
      await user(),
    ];
    await link(below, subject);
    expect((await put(subject, manager, reportsWriter)).status).toBe(200);
  });

  it("an admin may place any of them", async () => {
    const [subject, manager] = [await adminUser(), await user()];
    const [low, belowAdmin] = [await user(), await adminUser()];
    await link(belowAdmin, low);
    expect((await put(subject, manager, admin)).status).toBe(200);
    expect((await put(low, manager, admin)).status).toBe(200);
  });
});

describe("DELETE /v1/admin/users/:id/reports-to", () => {
  it("clears whatever the user and those below them hold", async () => {
    const [subject, manager] = [await adminUser(), await user()];
    const [low, belowAdmin] = [await user(), await adminUser()];
    await link(subject, manager);
    await link(low, manager);
    await link(belowAdmin, low);
    expect((await del(subject, reportsWriter)).status).toBe(204);
    expect((await del(low, reportsWriter)).status).toBe(204);
  });
});
