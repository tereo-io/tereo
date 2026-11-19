// @module-tag int
// @module-tag auth
// @module-tag race
import { getTestPrincipalToken } from "../../../../../../support/principals.js";
import { createTestUser } from "../../../../../../support/auth/users.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { adminApi } from "../../../../../../support/groups.js";

const ITERATIONS = 10;
const userIds: string[] = [];
let writer: string;

const put = (id: string, userId: string) =>
  adminApi("PUT", `/users/${id}/reports-to`, writer, { userId });

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

describe("PUT /v1/admin/users/:id/reports-to", () => {
  it("of two changes that together make a loop, exactly one commits", async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const a = (await createTestUser()).id;
      const b = (await createTestUser()).id;
      userIds.push(a, b);

      const results = await Promise.all([put(a, b), put(b, a)]);

      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 400]);
      expect(results.find((r) => r.status === 400)?.body.error).toBe(
        "reports_to_cycle"
      );
      const rows = await prisma.user.findMany({
        where: { id: { in: [a, b] } },
        select: { id: true, reportsToId: true },
      });
      const linked = rows.filter((r) => r.reportsToId !== null);
      expect(linked).toHaveLength(1);
    }
  });
});
