// @module-tag int
// @module-tag auth
import { describe, it, expect, beforeAll } from "vitest";
import { ConflictError } from "../../../utils/errors.js";
import { prisma } from "../../../utils/db/prisma.js";
import db from "../../../utils/db/index.js";
import { randomUUID } from "node:crypto";
import {
  ensureTestService,
  ensurePermission,
} from "../../support/testService.js";
import {
  ensureTestOrganization,
  ensureTestUser,
} from "../../support/principals.js";

const run = randomUUID().slice(0, 8);
const slug = (label: string) => `${label}-${run}`;

let actorId: string;
let orgA: string;
let orgB: string;

const make = (
  label: string,
  organizationId: string | null,
  extra: Partial<{ slug: string }> = {}
) =>
  db.groups.create({
    organizationId,
    slug: extra.slug ?? slug(label),
    name: label,
    description: null,
    definitionSource: "local",
    createdBy: actorId,
  });

const makeRole = async (label: string) => {
  await ensureTestService();
  const { TEST_SERVICE_ID } = await import("../../support/testService.js");
  return prisma.role.create({
    data: {
      name: `${label}-${run}`,
      displayName: label,
      serviceId: TEST_SERVICE_ID,
    },
  });
};

describe("db.groups", () => {
  beforeAll(async () => {
    actorId = await ensureTestUser(randomUUID());
    orgA = await ensureTestOrganization(`groups-a-${run}`);
    orgB = await ensureTestOrganization(`groups-b-${run}`);
    await ensurePermission("groups.read");
  });

  it("create refuses a duplicate slug in the same org with group_slug_taken", async () => {
    await make("dup-org", orgA);
    await expect(make("dup-org", orgA)).rejects.toMatchObject({
      statusCode: 409,
      code: "group_slug_taken",
    });
    await expect(make("dup-org", orgA)).rejects.toBeInstanceOf(ConflictError);
  });

  it("create refuses a duplicate global slug with group_slug_taken", async () => {
    await make("dup-global", null);
    await expect(make("dup-global", null)).rejects.toMatchObject({
      code: "group_slug_taken",
    });
  });

  it("create allows the same slug in another org and globally", async () => {
    await make("shared", orgA);
    await expect(make("shared", orgB)).resolves.toBeDefined();
    await expect(make("shared", null)).resolves.toBeDefined();
  });

  it("an archived group keeps its slug", async () => {
    const g = await make("archived", orgA);
    await db.groups.setArchived(g.id, new Date());
    await expect(make("archived", orgA)).rejects.toMatchObject({
      statusCode: 409,
      code: "group_slug_taken",
    });
  });

  it("update maps a slug collision to group_slug_taken", async () => {
    await make("upd-a", orgA);
    const b = await make("upd-b", orgA);
    await expect(
      db.groups.update(b.id, { slug: slug("upd-a") })
    ).rejects.toMatchObject({ code: "group_slug_taken" });
  });

  it("addMembers skips existing members and returns only the added ids", async () => {
    const g = await make("members", orgA);
    const u1 = await ensureTestUser(randomUUID());
    const u2 = await ensureTestUser(randomUUID());
    await db.$transaction(async (tx) => {
      expect(await db.groups.addMembers(g.id, [u1], actorId, tx)).toEqual([u1]);
      const added = await db.groups.addMembers(g.id, [u1, u2], actorId, tx);
      expect(added).toEqual([u2]);
    });
    expect((await db.groups.getMemberIds(g.id)).sort()).toEqual(
      [u1, u2].sort()
    );
    await db.$transaction(async (tx) => {
      expect(
        await db.groups.removeMembers(g.id, [u1, randomUUID()], tx)
      ).toEqual([u1]);
    });
  });

  it("replaceRoles returns added and removed role ids", async () => {
    const g = await make("roles", orgA);
    const r1 = await makeRole("r1");
    const r2 = await makeRole("r2");
    const r3 = await makeRole("r3");
    await db.$transaction(async (tx) => {
      expect(
        await db.groups.replaceRoles(g.id, [r1.id, r2.id], actorId, tx)
      ).toEqual({ added: [r1.id, r2.id].sort(), removed: [] });
      const res = await db.groups.replaceRoles(
        g.id,
        [r2.id, r3.id],
        actorId,
        tx
      );
      expect(res).toEqual({ added: [r3.id], removed: [r1.id] });
    });
    expect((await db.groups.getRoleIds(g.id)).sort()).toEqual(
      [r2.id, r3.id].sort()
    );
  });

  it("getUserGroups scopes by organizationId and hides archived groups", async () => {
    const u = await ensureTestUser(randomUUID());
    const global = await make("ug-global", null);
    const inA = await make("ug-a", orgA);
    const inB = await make("ug-b", orgB);
    const gone = await make("ug-gone", orgA);
    await db.$transaction(async (tx) => {
      for (const g of [global, inA, inB, gone])
        await db.groups.addMembers(g.id, [u], actorId, tx);
    });
    await db.groups.setArchived(gone.id, new Date());
    const ids = async (opts: Parameters<typeof db.groups.getUserGroups>[1]) =>
      (await db.groups.getUserGroups(u, opts)).map((g) => g.id).sort();
    expect(await ids({})).toEqual([global.id, inA.id, inB.id].sort());
    expect(await ids({ organizationId: null })).toEqual([global.id]);
    expect(await ids({ organizationId: orgA })).toEqual(
      [global.id, inA.id].sort()
    );
    expect(await ids({ includeArchived: true })).toHaveLength(4);
  });

  it("the database refuses a slug outside [a-z0-9-]{1,100}", async () => {
    await expect(make("bad", orgA, { slug: `Bad_${run}` })).rejects.toThrow(
      /groups_slug_format/
    );
  });

  it("the database refuses unprovisionedAt on a local group", async () => {
    const group = await make("local-unprov", orgA);
    await expect(
      prisma.group.update({
        where: { id: group.id },
        data: { unprovisionedAt: new Date() },
      })
    ).rejects.toThrow(/groups_unprovisioned_provisioned/);
  });
});
