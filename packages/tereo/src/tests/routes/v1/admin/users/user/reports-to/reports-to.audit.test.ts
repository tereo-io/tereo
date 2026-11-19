// @module-tag int
// @module-tag auth
// @module-tag audit
import { getTestPrincipalToken } from "../../../../../../support/principals.js";
import { createTestUser } from "../../../../../../support/auth/users.js";
import { emittedEvents } from "../../../../../../support/outboxLog.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { adminApi } from "../../../../../../support/groups.js";

const EVENT = "auth.user.reports-to-changed";
const userIds: string[] = [];
let writer: string;

const user = async () => {
  const created = await createTestUser();
  userIds.push(created.id);
  return created.id;
};

const put = (id: string, userId: string) =>
  adminApi("PUT", `/users/${id}/reports-to`, writer, { userId });
const del = (id: string) =>
  adminApi("DELETE", `/users/${id}/reports-to`, writer);

const entries = (id: string) =>
  prisma.auditLogEntry.findMany({
    where: { entityType: "User", entityId: id, action: "UPDATE" },
    orderBy: { createdAt: "asc" },
  });

beforeAll(async () => {
  writer = await getTestPrincipalToken({
    permissions: ["users.reports.write"],
  });
});

afterAll(async () => {
  await prisma.user.updateMany({
    where: { id: { in: userIds } },
    data: { reportsToId: null },
  });
});

describe("/v1/admin/users/:id/reports-to", () => {
  it("a set writes one audit entry and one auth.user.reports-to-changed", async () => {
    const [a, b] = [await user(), await user()];
    expect((await put(a, b)).status).toBe(200);

    const written = await entries(a);
    expect(written).toHaveLength(1);
    expect(written[0].changes).toEqual({ reportsToId: { old: null, new: b } });
    expect(written[0].metadata).toMatchObject({ action: "reports_to_changed" });

    const events = await emittedEvents(a, EVENT);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entityType: "User",
      entityId: a,
      data: { userId: a, reportsToId: b, previousReportsToId: null },
    });
  });

  it("a clear writes one audit entry and one event with the new value null", async () => {
    const [a, b] = [await user(), await user()];
    await put(a, b);
    expect((await del(a)).status).toBe(204);

    const written = await entries(a);
    expect(written).toHaveLength(2);
    expect(written[1].changes).toEqual({ reportsToId: { old: b, new: null } });
    expect(written[1].metadata).toMatchObject({ action: "reports_to_changed" });

    const events = await emittedEvents(a, EVENT);
    expect(events).toHaveLength(2);
    expect(events[1].data).toMatchObject({
      userId: a,
      reportsToId: null,
      previousReportsToId: b,
    });
  });

  it("a PUT repeating the current manager, or a DELETE with none set, writes nothing", async () => {
    const [a, b, c] = [await user(), await user(), await user()];
    await put(a, b);
    expect((await put(a, b)).status).toBe(200);
    expect((await del(c)).status).toBe(204);

    expect(await entries(a)).toHaveLength(1);
    expect(await emittedEvents(a, EVENT)).toHaveLength(1);
    expect(await entries(c)).toHaveLength(0);
    expect(await emittedEvents(c, EVENT)).toHaveLength(0);
  });
});
