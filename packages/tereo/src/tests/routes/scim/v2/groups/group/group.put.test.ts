// @module-tag int
// @module-tag auth
import { makeUser, tag } from "../../../../../support/scimUsers.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { pushGroup } from "../../../../../support/scim.js";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  asMembers,
  bodyMemberIds,
  groupAuditActions,
  groupEventCount,
  managedUser,
  memberIds,
  orgConnection,
  putGroup,
  skippedIds,
} from "../../../../../support/scimGroups.js";

describe("PUT /scim/v2/Groups/:id", () => {
  it("replaces the name, externalId and members, and keeps the slug", async () => {
    const c = await orgConnection();
    const [a, b, d] = [
      await managedUser(c),
      await managedUser(c),
      await managedUser(c),
    ];
    const pushed = await pushGroup(c.token, {
      displayName: `Old ${tag()}`,
      externalId: "ext-old",
      members: asMembers(a.id, b.id),
    });
    const id = pushed.body.id;
    const slug = (await prisma.group.findUniqueOrThrow({ where: { id } })).slug;

    const newName = `New ${tag()}`;
    const r = await putGroup(c.token, id, {
      displayName: newName,
      externalId: "ext-new",
      members: asMembers(b.id, d.id),
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id,
      displayName: newName,
      externalId: "ext-new",
    });
    expect(bodyMemberIds(r.body)).toEqual([b.id, d.id].sort());
    expect(await memberIds(id)).toEqual([b.id, d.id].sort());

    const group = await prisma.group.findUniqueOrThrow({
      where: { id },
      include: { scimLink: true },
    });
    expect(group).toMatchObject({ slug, name: newName });
    expect(group.scimLink).toMatchObject({
      displayName: newName,
      displayNameKey: newName.toLowerCase(),
      externalId: "ext-new",
    });
  });

  it("clears the externalId when the body has none", async () => {
    const c = await orgConnection();
    const pushed = await pushGroup(c.token, {
      displayName: `E ${tag()}`,
      externalId: "ext-1",
    });
    const r = await putGroup(c.token, pushed.body.id, {
      displayName: pushed.body.displayName,
    });
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty("externalId");
  });

  it("empties the group when members is empty or absent", async () => {
    const c = await orgConnection();
    const a = await managedUser(c);
    const pushed = await pushGroup(c.token, {
      displayName: `Z ${tag()}`,
      members: asMembers(a.id),
    });
    const r = await putGroup(c.token, pushed.body.id, {
      displayName: pushed.body.displayName,
      members: [],
    });
    expect(r.status).toBe(200);
    expect(r.body.members).toEqual([]);
    expect(await memberIds(pushed.body.id)).toEqual([]);

    await putGroup(c.token, pushed.body.id, {
      displayName: pushed.body.displayName,
      members: asMembers(a.id),
    });
    const again = await putGroup(c.token, pushed.body.id, {
      displayName: pushed.body.displayName,
    });
    expect(again.body.members).toEqual([]);
    expect(await memberIds(pushed.body.id)).toEqual([]);
  });

  it("writes no audit entry and no event for a body identical to the current state", async () => {
    const c = await orgConnection();
    const a = await managedUser(c);
    const body = {
      displayName: `Same ${tag()}`,
      externalId: "ext-same",
      members: asMembers(a.id),
    };
    const pushed = await pushGroup(c.token, body);
    const id = pushed.body.id;
    const audit = await groupAuditActions(id);
    const events = await groupEventCount(id);
    const modified = pushed.body.meta.lastModified;

    const r = await putGroup(c.token, id, body);
    expect(r.status).toBe(200);
    expect(await groupAuditActions(id)).toEqual(audit);
    expect(await groupEventCount(id)).toBe(events);
    expect(r.body.meta.lastModified).toBe(modified);
  });

  it("moves meta.lastModified when only the members change", async () => {
    const c = await orgConnection();
    const a = await managedUser(c);
    const pushed = await pushGroup(c.token, { displayName: `L ${tag()}` });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const r = await putGroup(c.token, pushed.body.id, {
      displayName: pushed.body.displayName,
      members: asMembers(a.id),
    });
    expect(Date.parse(r.body.meta.lastModified)).toBeGreaterThan(
      Date.parse(pushed.body.meta.lastModified)
    );
    expect(Date.parse(r.body.meta.created)).toBe(
      Date.parse(pushed.body.meta.created)
    );
  });

  it("retries recorded skips: a member who has since joined the organization is added", async () => {
    const c = await orgConnection();
    const late = await managedUser(c, { inOrg: false });
    const body = {
      displayName: `Late ${tag()}`,
      members: asMembers(late.id),
    };
    const pushed = await pushGroup(c.token, body);
    expect(await skippedIds(pushed.body.id)).toEqual([late.id]);

    await prisma.organizationMember.create({
      data: { organizationId: c.organizationId, userId: late.id },
    });
    const r = await putGroup(c.token, pushed.body.id, body);
    expect(bodyMemberIds(r.body)).toEqual([late.id]);
    expect(await skippedIds(pushed.body.id)).toEqual([]);
  });

  it("ignores unknown, malformed and other connections' members", async () => {
    const c = await orgConnection();
    const other = await orgConnection();
    const theirs = await managedUser(other);
    const mine = await managedUser(c);
    const pushed = await pushGroup(c.token, { displayName: `I ${tag()}` });
    const r = await putGroup(c.token, pushed.body.id, {
      displayName: pushed.body.displayName,
      members: asMembers(mine.id, theirs.id, randomUUID(), "not-a-uuid"),
    });
    expect(r.status).toBe(200);
    expect(bodyMemberIds(r.body)).toEqual([mine.id]);
    expect(await skippedIds(pushed.body.id)).toEqual([]);
  });

  it("is 404 for another connection's group, a local group and a non-uuid, leaving the other group untouched", async () => {
    const a = await orgConnection();
    const b = await orgConnection();
    const theirs = await pushGroup(b.token, { displayName: `T ${tag()}` });
    const local = await prisma.group.create({
      data: {
        organizationId: a.organizationId,
        slug: `local-${tag()}`,
        name: "Local",
        definitionSource: "local",
        createdBy: (await makeUser(`l-${tag()}@${a.domain}`)).id,
      },
    });
    const body = { displayName: "Hijacked", externalId: "x" };
    expect((await putGroup(a.token, theirs.body.id, body)).status).toBe(404);
    expect((await putGroup(a.token, local.id, body)).status).toBe(404);
    expect((await putGroup(a.token, "not-a-uuid", body)).status).toBe(404);

    const untouched = await prisma.group.findUniqueOrThrow({
      where: { id: theirs.body.id },
      include: { scimLink: true },
    });
    expect(untouched.name).toBe(theirs.body.displayName);
    expect(untouched.scimLink?.externalId).toBeNull();
    const stillLocal = await prisma.group.findUniqueOrThrow({
      where: { id: local.id },
    });
    expect(stillLocal).toMatchObject({ name: "Local" });
  });

  it("rejects a missing or blank displayName", async () => {
    const c = await orgConnection();
    const pushed = await pushGroup(c.token, { displayName: `V ${tag()}` });
    for (const body of [{}, { displayName: "  " }]) {
      const r = await putGroup(c.token, pushed.body.id, body);
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ scimType: "invalidValue" });
    }
  });
});
