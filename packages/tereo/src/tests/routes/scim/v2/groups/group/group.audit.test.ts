// @module-tag int
// @module-tag auth
import { removeFromOrgGroupsTx } from "../../../../../../utils/groups.js";
import { SYSTEM_USER_ID } from "../../../../../../definitions/index.js";
import { emittedEvents } from "../../../../../support/outboxLog.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { pushGroup } from "../../../../../support/scim.js";
import { tag } from "../../../../../support/scimUsers.js";
import db from "../../../../../../utils/db/index.js";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  asMembers,
  groupAuditActions,
  groupEventCount,
  managedUser,
  orgConnection,
  patchGroup,
  patchOps,
  putGroup,
} from "../../../../../support/scimGroups.js";

const entries = (groupId: string, detail: string) =>
  prisma.auditLogEntry.findMany({
    where: {
      entityType: "Group",
      entityId: groupId,
      metadata: { path: ["action"], equals: detail },
    },
  });

const eventTypes = async (groupId: string) =>
  (await emittedEvents(groupId)).map((event) => event.eventType);

describe("SCIM group change audit and events", () => {
  it("an organization removal records a skip and moves the link's lastModified", async () => {
    const c = await orgConnection();
    const user = await managedUser(c);
    const pushed = await pushGroup(c.token, {
      displayName: `Org ${tag()}`,
      members: asMembers(user.id),
    });
    const id = pushed.body.id;
    const before = await prisma.scimGroup.findUniqueOrThrow({
      where: { groupId: id },
    });

    await db.$transaction(async (tx) => {
      await db.users.lockAuthority(user.id, tx);
      await tx.organizationMember.deleteMany({
        where: { organizationId: c.organizationId, userId: user.id },
      });
      await removeFromOrgGroupsTx(
        tx,
        { userId: SYSTEM_USER_ID, email: null },
        c.organizationId,
        user.id
      );
    });

    const after = await prisma.scimGroup.findUniqueOrThrow({
      where: { groupId: id },
    });
    expect(after.updatedAt.getTime()).toBeGreaterThan(
      before.updatedAt.getTime()
    );
  });

  it("writes members_added with the system actor, the connection, and skipped and dropped counts", async () => {
    const c = await orgConnection();
    const member = await managedUser(c);
    const outsider = await managedUser(c, { inOrg: false });
    const pushed = await pushGroup(c.token, { displayName: `A ${tag()}` });
    const id = pushed.body.id;

    await patchGroup(
      c.token,
      id,
      patchOps({
        op: "add",
        path: "members",
        value: asMembers(member.id, outsider.id, randomUUID()),
      })
    );
    const [entry] = await entries(id, "members_added");
    expect(entry.userId).toBe(SYSTEM_USER_ID);
    expect(entry.metadata).toMatchObject({
      scimConnectionId: c.connectionId,
      skipped: 1,
      dropped: 1,
    });
    expect(await eventTypes(id)).toContain("auth.group.members-added");
  });

  it("writes members_removed for a removal and no entry when the removed user was not a member", async () => {
    const c = await orgConnection();
    const [a, b] = [await managedUser(c), await managedUser(c)];
    const pushed = await pushGroup(c.token, {
      displayName: `R ${tag()}`,
      members: asMembers(a.id),
    });
    const id = pushed.body.id;

    await patchGroup(
      c.token,
      id,
      patchOps({ op: "remove", path: `members[value eq "${b.id}"]` })
    );
    expect(await entries(id, "members_removed")).toHaveLength(0);

    await putGroup(c.token, id, {
      displayName: pushed.body.displayName,
      members: [],
    });
    const [entry] = await entries(id, "members_removed");
    expect(entry.userId).toBe(SYSTEM_USER_ID);
    expect(entry.metadata).toMatchObject({ scimConnectionId: c.connectionId });
    expect(await eventTypes(id)).toContain("auth.group.members-removed");
  });

  it("records a rename as an UPDATE with the changes, and emits auth.group.updated", async () => {
    const c = await orgConnection();
    const pushed = await pushGroup(c.token, { displayName: `N ${tag()}` });
    const id = pushed.body.id;
    const before = await groupEventCount(id);

    await patchGroup(
      c.token,
      id,
      patchOps({ op: "replace", path: "displayName", value: "Renamed" })
    );
    const updates = (await prisma.auditLogEntry.findMany({
      where: { entityType: "Group", entityId: id, action: "UPDATE" },
    })) as Array<{ userId: string; metadata: unknown; changes: unknown }>;
    expect(updates).toHaveLength(1);
    expect(updates[0].userId).toBe(SYSTEM_USER_ID);
    expect(JSON.stringify(updates[0].changes)).toContain("Renamed");
    expect(updates[0].metadata).toMatchObject({
      scimConnectionId: c.connectionId,
    });
    expect(await groupEventCount(id)).toBe(before + 1);
    expect(await eventTypes(id)).toContain("auth.group.updated");
  });

  it("audits skipped members when nothing was added, and emits no event", async () => {
    const c = await orgConnection();
    const outsider = await managedUser(c, { inOrg: false });
    const pushed = await pushGroup(c.token, { displayName: `S ${tag()}` });
    const id = pushed.body.id;
    const before = await groupEventCount(id);

    await patchGroup(
      c.token,
      id,
      patchOps({ op: "add", path: "members", value: asMembers(outsider.id) })
    );
    const [entry] = await entries(id, "members_skipped");
    expect(entry.metadata).toMatchObject({ skipped: 1, dropped: 0 });
    expect(await groupEventCount(id)).toBe(before);
    expect(await groupAuditActions(id)).not.toContainEqual({
      action: "UPDATE",
      detail: "members_added",
    });
  });

  it("an identical PUT on a group with a recorded skip and an unknown id writes nothing", async () => {
    const c = await orgConnection();
    const member = await managedUser(c);
    const outsider = await managedUser(c, { inOrg: false });
    const body = {
      displayName: `Same ${tag()}`,
      members: asMembers(member.id, outsider.id, randomUUID()),
    };
    const pushed = await pushGroup(c.token, body);
    const id = pushed.body.id;
    const audit = await groupAuditActions(id);
    const events = await groupEventCount(id);

    const r = await putGroup(c.token, id, body);
    expect(r.status).toBe(200);
    expect(await groupAuditActions(id)).toEqual(audit);
    expect(await groupEventCount(id)).toBe(events);
    expect(r.body.meta.lastModified).toBe(pushed.body.meta.lastModified);
  });

  it("writes members_skipped when a request changes the recorded skips and adds nobody", async () => {
    const c = await orgConnection();
    const outsider = await managedUser(c, { inOrg: false });
    const pushed = await pushGroup(c.token, { displayName: `Ch ${tag()}` });
    const id = pushed.body.id;
    await patchGroup(
      c.token,
      id,
      patchOps({ op: "add", path: "members", value: asMembers(outsider.id) })
    );
    await patchGroup(
      c.token,
      id,
      patchOps({
        op: "remove",
        path: `members[value eq "${outsider.id}"]`,
      })
    );
    expect(await entries(id, "members_skipped")).toHaveLength(2);
  });
});
