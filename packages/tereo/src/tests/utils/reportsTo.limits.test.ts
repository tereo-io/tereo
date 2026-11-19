// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { createAdminUser, createTestUser } from "../support/auth/users.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { UnprocessableEntityError } from "../../utils/errors.js";
import { prisma } from "../../utils/db/prisma.js";
import {
  listReports,
  REPORTS_LIMITS,
  setReportsTo,
} from "../../utils/reportsTo.js";

const userIds: string[] = [];
let actor: { userId: string; email: string };

const user = async () => {
  const created = await createTestUser();
  userIds.push(created.id);
  return created.id;
};

/** A user with a chain `depth` long below them. */
const withChainBelow = async (depth: number) => {
  const top = await user();
  let above = top;
  for (let i = 0; i < depth; i++) {
    const next = await user();
    await prisma.user.update({
      where: { id: next },
      data: { reportsToId: above },
    });
    above = next;
  }
  return top;
};

beforeAll(async () => {
  await ensureDefaultOrganization();
  const admin = await createAdminUser();
  actor = { userId: admin.id, email: admin.email };
});

afterAll(async () => {
  await prisma.user.updateMany({
    where: { id: { in: userIds } },
    data: { reportsToId: null },
  });
});

describe("setReportsTo", () => {
  it("bounds the subtree the authority check walks at 10,000 users and 64 levels", () => {
    expect(REPORTS_LIMITS).toEqual({ maxUsers: 10_000, maxDepth: 64 });
  });

  it.each([
    ["more users", { maxUsers: 2, maxDepth: 64 }],
    ["more levels", { maxUsers: 100, maxDepth: 2 }],
  ])(
    "refuses with reports_limit_exceeded when the subtree holds %s than the limit",
    async (_label, limits) => {
      const subject = await withChainBelow(3);
      const manager = await user();
      const attempt = setReportsTo(actor, subject, manager, limits);
      await expect(attempt).rejects.toBeInstanceOf(UnprocessableEntityError);
      await expect(attempt).rejects.toMatchObject({
        code: "reports_limit_exceeded",
      });
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: subject },
      });
      expect(row.reportsToId).toBeNull();
    }
  );

  it("sets it when the subtree is within the limits", async () => {
    const subject = await withChainBelow(2);
    const manager = await user();
    const view = await setReportsTo(actor, subject, manager, {
      maxUsers: 2,
      maxDepth: 2,
    });
    expect(view.reportsTo?.id).toBe(manager);
  });
});

describe("listReports", () => {
  /** D <- C <- {B, E}, and A <- B: four below D, three levels deep. */
  const tree = async () => {
    const [d, c, b, e, a] = [
      await user(),
      await user(),
      await user(),
      await user(),
      await user(),
    ];
    for (const [id, reportsToId] of [
      [c, d],
      [b, c],
      [e, c],
      [a, b],
    ]) {
      await prisma.user.update({ where: { id }, data: { reportsToId } });
    }
    return d;
  };

  it.each([
    ["more users", { maxUsers: 3, maxDepth: 64 }],
    ["more levels", { maxUsers: 100, maxDepth: 2 }],
  ])(
    "refuses with reports_limit_exceeded when the tree holds %s than the limit",
    async (_label, limits) => {
      const top = await tree();
      const attempt = listReports(top, { transitive: true }, limits);
      await expect(attempt).rejects.toBeInstanceOf(UnprocessableEntityError);
      await expect(attempt).rejects.toMatchObject({
        code: "reports_limit_exceeded",
      });
    }
  );

  it("allows a tree exactly at the bounds", async () => {
    const top = await tree();
    const rows = await listReports(
      top,
      { transitive: true },
      { maxUsers: 4, maxDepth: 3 }
    );
    expect(rows).toHaveLength(4);
  });
});
