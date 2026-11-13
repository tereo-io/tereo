// @module-tag int
// @module-tag auth
import { prisma } from "../../../../../../utils/db/prisma.js";
import { pushGroup } from "../../../../../support/scim.js";
import { tag } from "../../../../../support/scimUsers.js";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  asMembers,
  managedUser,
  memberIds,
  orgConnection,
  patchGroup,
  patchOps,
  putGroup,
  seedMembers,
  seedUsers,
  skippedIds,
} from "../../../../../support/scimGroups.js";

const addedBy = async (groupId: string) =>
  (await prisma.group.findUniqueOrThrow({ where: { id: groupId } })).createdBy;

const tooMany = (r: { status: number; body: unknown }) => {
  expect(r.status).toBe(400);
  expect(r.body).toMatchObject({ status: "400", scimType: "tooMany" });
};

describe("SCIM group member limits", () => {
  it("refuses 1,001 adds in one PATCH and applies none of the request", async () => {
    const c = await orgConnection();
    const real = await managedUser(c);
    const pushed = await pushGroup(c.token, { displayName: `Cap ${tag()}` });
    const id = pushed.body.id;
    const ids = [real.id, ...Array.from({ length: 1000 }, () => randomUUID())];

    const r = await patchGroup(
      c.token,
      id,
      patchOps(
        { op: "add", path: "members", value: asMembers(...ids) },
        { op: "replace", path: "displayName", value: "Renamed" }
      )
    );
    tooMany(r);
    expect(await memberIds(id)).toEqual([]);
    expect((await prisma.group.findUniqueOrThrow({ where: { id } })).name).toBe(
      pushed.body.displayName
    );
  });

  it("accepts exactly 1,000 changes", async () => {
    const c = await orgConnection();
    const pushed = await pushGroup(c.token, { displayName: `Edge ${tag()}` });
    const ids = Array.from({ length: 1000 }, () => randomUUID());
    const r = await patchGroup(
      c.token,
      pushed.body.id,
      patchOps({ op: "add", path: "members", value: asMembers(...ids) })
    );
    expect(r.status).toBe(200);
  });

  it("counts the diff of a PUT, not its size: 1,500 current plus 10 new succeeds", async () => {
    const c = await orgConnection();
    const pushed = await pushGroup(c.token, { displayName: `Diff ${tag()}` });
    const id = pushed.body.id;
    const current = await seedMembers(id, 1500, await addedBy(id));
    const fresh = await Promise.all(
      Array.from({ length: 10 }, () => managedUser(c))
    );

    const r = await putGroup(c.token, id, {
      displayName: pushed.body.displayName,
      members: asMembers(...current, ...fresh.map((u) => u.id)),
    });
    expect(r.status).toBe(200);
    expect(r.body.members).toHaveLength(1510);
    expect(await memberIds(id)).toHaveLength(1510);
  });

  it("refuses a PUT that would remove more than 1,000 members, changing nothing", async () => {
    const c = await orgConnection();
    const pushed = await pushGroup(c.token, { displayName: `Rm ${tag()}` });
    const id = pushed.body.id;
    await seedMembers(id, 1001, await addedBy(id));

    tooMany(
      await putGroup(c.token, id, {
        displayName: "Gone",
        members: [],
      })
    );
    expect(await memberIds(id)).toHaveLength(1001);
    expect((await prisma.group.findUniqueOrThrow({ where: { id } })).name).toBe(
      pushed.body.displayName
    );
  });

  it("refuses to take a group of 5,000 past 5,000", async () => {
    const c = await orgConnection();
    const one = await managedUser(c);
    const pushed = await pushGroup(c.token, { displayName: `Full ${tag()}` });
    const id = pushed.body.id;
    await seedMembers(id, 5000, await addedBy(id));

    tooMany(
      await patchGroup(
        c.token,
        id,
        patchOps({ op: "add", path: "members", value: asMembers(one.id) })
      )
    );
    expect(await memberIds(id)).toHaveLength(5000);

    const swap = await patchGroup(
      c.token,
      id,
      patchOps(
        { op: "add", path: "members", value: asMembers(one.id) },
        {
          op: "remove",
          path: `members[value eq "${(await memberIds(id))[0]}"]`,
        }
      )
    );
    expect(swap.status).toBe(200);
    expect(swap.body.members).toHaveLength(5000);
  });

  it("refuses a request that names more than 5,000 members", async () => {
    const c = await orgConnection();
    const pushed = await pushGroup(c.token, { displayName: `Big ${tag()}` });
    const members = asMembers(
      ...Array.from({ length: 5001 }, () => randomUUID())
    );
    tooMany(
      await putGroup(c.token, pushed.body.id, {
        displayName: pushed.body.displayName,
        members,
      })
    );
    tooMany(
      await patchGroup(
        c.token,
        pushed.body.id,
        patchOps({ op: "add", path: "members", value: members })
      )
    );
  });

  it("retries recorded skips only within the budget the request leaves, keeping the rest recorded", async () => {
    const c = await orgConnection();
    const member = await managedUser(c);
    const pushed = await pushGroup(c.token, { displayName: `Rec ${tag()}` });
    const id = pushed.body.id;
    const link = await prisma.scimGroup.findUniqueOrThrow({
      where: { groupId: id },
    });
    const recorded = await seedUsers(1005);
    await prisma.scimGroupSkippedMember.createMany({
      data: recorded.map((userId) => ({
        scimGroupId: link.id,
        userId,
        reason: "not_org_member",
      })),
    });

    const r = await patchGroup(
      c.token,
      id,
      patchOps({ op: "add", path: "members", value: asMembers(member.id) })
    );
    expect(r.status).toBe(200);
    expect(await memberIds(id)).toEqual([member.id]);
    // 999 retried (the lowest ids; unmanaged users, so dropped), 6 untouched.
    expect(await skippedIds(id)).toEqual(recorded.slice(999));
  });

  it("deletes a recorded skip the request omits, even past the budget", async () => {
    const c = await orgConnection();
    const pushed = await pushGroup(c.token, { displayName: `Om ${tag()}` });
    const id = pushed.body.id;
    const link = await prisma.scimGroup.findUniqueOrThrow({
      where: { groupId: id },
    });
    const recorded = await seedUsers(1005);
    await prisma.scimGroupSkippedMember.createMany({
      data: recorded.map((userId) => ({
        scimGroupId: link.id,
        userId,
        reason: "not_org_member",
      })),
    });
    const r = await putGroup(c.token, id, {
      displayName: pushed.body.displayName,
      members: [],
    });
    expect(r.status).toBe(200);
    expect(await skippedIds(id)).toEqual([]);
  });
});
