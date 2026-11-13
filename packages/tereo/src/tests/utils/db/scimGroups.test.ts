// @module-tag int
// @module-tag auth
import { makeUser, manage, tag } from "../../support/scimUsers.js";
import { groupSlug, deleteGroups } from "../../support/groups.js";
import { SYSTEM_USER_ID } from "../../../definitions/index.js";
import { createScimConnection } from "../../support/scim.js";
import { prisma } from "../../../utils/db/prisma.js";
import { describe, it, expect } from "vitest";
import db from "../../../utils/db/index.js";

const makeGroup = async (organizationId: string | null = null) =>
  await db.groups.create({
    organizationId,
    slug: groupSlug("sg"),
    name: "Group",
    description: null,
    definitionSource: "scim",
    membershipSource: "scim",
    createdBy: SYSTEM_USER_ID,
  });

const linked = async (
  connectionId: string,
  displayName: string,
  externalId: string | null = null
) => {
  const group = await makeGroup();
  const link = await db.$transaction((tx) =>
    db.scimGroups.createLink(
      { connectionId, groupId: group.id, externalId, displayName },
      tx
    )
  );
  return { group, link };
};

describe("db.scimGroups", () => {
  it("looks a link up by connection and group", async () => {
    const a = await createScimConnection();
    const b = await createScimConnection();
    const { group, link } = await linked(a.connectionId, "Engineering");
    try {
      expect(
        (await db.scimGroups.getLinkForConnection(a.connectionId, group.id))?.id
      ).toBe(link.id);
      expect(
        await db.scimGroups.getLinkForConnection(b.connectionId, group.id)
      ).toBeNull();
    } finally {
      await prisma.scimGroup.delete({ where: { id: link.id } });
      await deleteGroups([group.id]);
    }
  });

  it("filters displayName by lower-cased equality, never as a pattern", async () => {
    const c = await createScimConnection();
    const { group, link } = await linked(c.connectionId, "Engineering");
    try {
      const find = async (value: string) =>
        (
          await db.scimGroups.listLinks(c.connectionId, {
            filter: [{ attr: "displayName", value }],
            skip: 0,
            take: 10,
          })
        ).total;
      expect(await find("ENGINEERING")).toBe(1);
      expect(await find("Eng%")).toBe(0);
    } finally {
      await prisma.scimGroup.delete({ where: { id: link.id } });
      await deleteGroups([group.id]);
    }
  });

  it("replaces the skipped set and cascades it on deleteLink", async () => {
    const c = await createScimConnection();
    const { group, link } = await linked(c.connectionId, "Ops");
    const a = await makeUser(`a-${tag()}@skip.test`);
    const b = await makeUser(`b-${tag()}@skip.test`);
    try {
      await db.$transaction(async (tx) => {
        await db.scimGroups.setSkipped(
          link.id,
          [a.id, b.id],
          "not_org_member",
          tx
        );
        await db.scimGroups.setSkipped(link.id, [b.id], "not_org_member", tx);
        expect(await db.scimGroups.listSkippedIds(link.id, tx)).toEqual([b.id]);
        await db.scimGroups.deleteLink(link.id, tx);
      });
      expect(
        await prisma.scimGroupSkippedMember.count({
          where: { scimGroupId: link.id },
        })
      ).toBe(0);
    } finally {
      await deleteGroups([group.id]);
    }
  });

  it("filterLiveLinked leaves out deleted and unlinked links", async () => {
    const c = await createScimConnection();
    const live = await makeUser(`l-${tag()}@live.test`);
    const gone = await makeUser(`d-${tag()}@live.test`);
    const off = await makeUser(`u-${tag()}@live.test`);
    await manage(c.connectionId, live.id, "live");
    await manage(c.connectionId, gone.id, "gone", { deletedAt: new Date() });
    await manage(c.connectionId, off.id, "off", { unlinkedAt: new Date() });
    const result = await db.$transaction((tx) =>
      db.scim.filterLiveLinked(c.connectionId, [live.id, gone.id, off.id], tx)
    );
    expect(result).toEqual([live.id]);
  });

  it("linkedScope is null without links and names the scope with one", async () => {
    const c = await createScimConnection();
    expect(
      await db.$transaction((tx) =>
        db.scimGroups.linkedScope(c.connectionId, tx)
      )
    ).toBeNull();
    const { group, link } = await linked(c.connectionId, "Scoped");
    try {
      expect(
        await db.$transaction((tx) =>
          db.scimGroups.linkedScope(c.connectionId, tx)
        )
      ).toEqual({ organizationId: null });
    } finally {
      await prisma.scimGroup.delete({ where: { id: link.id } });
      await deleteGroups([group.id]);
    }
  });

  it("rejects an organization target without an organization", async () => {
    const c = await createScimConnection();
    await expect(
      prisma.scimConnection.update({
        where: { id: c.connectionId },
        data: { groupsTarget: "organization" },
      })
    ).rejects.toThrow();
    const set = await db.$transaction((tx) =>
      db.scim.setGroupsTarget(
        c.connectionId,
        { kind: "organization", organizationId: c.organizationId },
        tx
      )
    );
    expect(set.groupsOrganizationId).toBe(c.organizationId);
  });
});
