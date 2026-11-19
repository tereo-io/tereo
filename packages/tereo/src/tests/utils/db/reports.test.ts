// @module-tag int
// @module-tag auth
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import db from "../../../utils/db/index.js";
import { randomUUID } from "node:crypto";

const run = randomUUID().slice(0, 8);
const created: string[] = [];

const mkUser = async (label: string, isActive = true) => {
  const u = await prisma.user.create({
    data: { email: `reports-${label}-${run}@example.test`, isActive },
  });
  created.push(u.id);
  return u;
};

const link = (userId: string, reportsToId: string | null) =>
  db.$transaction((tx) => db.reports.setReportsTo(userId, reportsToId, tx));

const limits = { transitive: true, maxUsers: 100, maxDepth: 64 };

afterAll(async () => {
  await prisma.user.updateMany({
    where: { id: { in: created } },
    data: { reportsToId: null },
  });
  await prisma.user.deleteMany({ where: { id: { in: created } } });
});

describe("db.reports", () => {
  it("refuses a user reporting to themselves", async () => {
    const a = await mkUser("self");
    await expect(
      prisma.user.update({ where: { id: a.id }, data: { reportsToId: a.id } })
    ).rejects.toThrow(/users_reports_to_not_self/);
  });

  it("refuses deleting a user others report to", async () => {
    const boss = await mkUser("del-boss");
    const rep = await mkUser("del-rep");
    await link(rep.id, boss.id);
    await expect(
      prisma.user.delete({ where: { id: boss.id } })
    ).rejects.toThrow(/users_reports_to_id_fkey/);
  });

  it("chainAbove walks to the top", async () => {
    const a = await mkUser("ch-a");
    const b = await mkUser("ch-b");
    const c = await mkUser("ch-c");
    await link(a.id, b.id);
    await link(b.id, c.id);
    const chain = await db.$transaction((tx) =>
      db.reports.chainAbove(a.id, tx)
    );
    expect(chain).toEqual([b.id, c.id]);
  });

  it("listBelow direct lists depth 1 only", async () => {
    const top = await mkUser("d-top");
    const mid = await mkUser("d-mid");
    const low = await mkUser("d-low");
    await link(mid.id, top.id);
    await link(low.id, mid.id);
    const { rows, overLimit } = await db.reports.listBelow(top.id, {
      ...limits,
      transitive: false,
    });
    expect(rows.map((r) => r.id)).toEqual([mid.id]);
    expect(rows[0]?.depth).toBe(1);
    expect(overLimit).toBe(false);
    expect(await db.reports.countDirect(top.id)).toBe(1);
  });

  it("listBelow transitive includes deactivated users and those below them", async () => {
    const c = await mkUser("t-c");
    const b = await mkUser("t-b", false);
    const a = await mkUser("t-a");
    await link(b.id, c.id);
    await link(a.id, b.id);
    const { rows } = await db.reports.listBelow(c.id, limits);
    expect(rows.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(rows.map((r) => r.depth)).toEqual([1, 2]);
    expect(rows[0]?.isActive).toBe(false);
  });

  it("listBelow reports overLimit on users", async () => {
    const boss = await mkUser("u-boss");
    for (const l of ["1", "2", "3"]) {
      const r = await mkUser(`u-r${l}`);
      await link(r.id, boss.id);
    }
    const res = await db.reports.listBelow(boss.id, {
      ...limits,
      maxUsers: 2,
    });
    expect(res.overLimit).toBe(true);
    expect(res.rows).toHaveLength(2);
  });

  it("listBelow reports overLimit on depth", async () => {
    const chain = [];
    for (const l of ["0", "1", "2", "3"]) chain.push(await mkUser(`p-${l}`));
    for (let i = 1; i < chain.length; i++)
      await link(chain[i]!.id, chain[i - 1]!.id);
    const res = await db.reports.listBelow(chain[0]!.id, {
      ...limits,
      maxDepth: 2,
    });
    expect(res.overLimit).toBe(true);
  });

  it("listBelow is not over the limit exactly at maxUsers", async () => {
    const boss = await mkUser("eu-boss");
    for (const l of ["1", "2", "3"]) {
      const r = await mkUser(`eu-r${l}`);
      await link(r.id, boss.id);
    }
    const res = await db.reports.listBelow(boss.id, {
      ...limits,
      maxUsers: 3,
    });
    expect(res.overLimit).toBe(false);
    expect(res.rows).toHaveLength(3);
  });

  it("listBelow is not over the limit exactly at maxDepth", async () => {
    const chain = [];
    for (const l of ["0", "1", "2", "3"]) chain.push(await mkUser(`ed-${l}`));
    for (let i = 1; i < chain.length; i++)
      await link(chain[i]!.id, chain[i - 1]!.id);
    const res = await db.reports.listBelow(chain[0]!.id, {
      ...limits,
      maxDepth: 3,
    });
    expect(res.overLimit).toBe(false);
    expect(res.rows.map((r) => r.depth)).toEqual([1, 2, 3]);
  });
});
