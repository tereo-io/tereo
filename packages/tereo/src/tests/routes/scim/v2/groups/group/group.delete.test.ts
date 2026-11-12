// @module-tag int
// @module-tag auth
import { makeUser, manage, tag } from "../../../../../support/scimUsers.js";
import { createTestRole } from "../../../../../support/auth/users.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { joinOrg } from "../../../../../support/groups.js";
import { describe, expect, it } from "vitest";
import {
  createScimConnection,
  pushGroup,
  scimFetch,
  setGroupsTarget,
} from "../../../../../support/scim.js";

const orgConnection = async () => {
  const c = await createScimConnection();
  await setGroupsTarget(c.connectionId, {
    kind: "organization",
    organizationId: c.organizationId,
  });
  return c;
};

const del = (token: string, id: string) =>
  scimFetch(token, "DELETE", `/scim/v2/Groups/${id}`);

describe("DELETE /scim/v2/Groups/:id", () => {
  it("archives the group and makes it local, keeping members and roles", async () => {
    const c = await orgConnection();
    const user = await makeUser(`m-${tag()}@${c.domain}`);
    await joinOrg(c.organizationId, user.id);
    await manage(c.connectionId, user.id, user.email);
    const pushed = await pushGroup(c.token, {
      displayName: `D ${tag()}`,
      members: [{ value: user.id }],
    });
    const id = pushed.body.id;
    const role = await createTestRole();
    await prisma.groupRole.create({
      data: { groupId: id, roleId: role.id, addedBy: user.id },
    });

    expect((await del(c.token, id)).status).toBe(204);
    const group = await prisma.group.findUniqueOrThrow({
      where: { id },
      include: { scimLink: true, members: true, roles: true },
    });
    expect(group.archivedAt).not.toBeNull();
    expect(group).toMatchObject({
      definitionSource: "local",
      membershipSource: "local",
      scimLink: null,
    });
    expect(group.members).toHaveLength(1);
    expect(group.roles).toHaveLength(1);

    const audit = await prisma.auditLogEntry.findFirst({
      where: {
        entityId: id,
        action: "UPDATE",
        metadata: { path: ["action"], equals: "scim_unlinked" },
      },
    });
    expect(audit?.metadata).toMatchObject({
      action: "scim_unlinked",
      reason: "scim_deleted",
      scimConnectionId: c.connectionId,
    });
  });

  it("is 404 the second time, and a re-push makes a new group without roles", async () => {
    const c = await orgConnection();
    const name = `R ${tag()}`;
    const first = await pushGroup(c.token, { displayName: name });
    expect((await del(c.token, first.body.id)).status).toBe(204);
    expect((await del(c.token, first.body.id)).status).toBe(404);
    const again = await pushGroup(c.token, { displayName: name });
    expect(again.status).toBe(201);
    expect(again.body.id).not.toBe(first.body.id);
    expect(
      await prisma.groupRole.count({ where: { groupId: again.body.id } })
    ).toBe(0);
  });

  it("deletes an already-archived linked group", async () => {
    const c = await orgConnection();
    const pushed = await pushGroup(c.token, { displayName: `X ${tag()}` });
    await prisma.group.update({
      where: { id: pushed.body.id },
      data: { archivedAt: new Date() },
    });
    expect((await del(c.token, pushed.body.id)).status).toBe(204);
    const group = await prisma.group.findUniqueOrThrow({
      where: { id: pushed.body.id },
      include: { scimLink: true },
    });
    expect(group).toMatchObject({ definitionSource: "local", scimLink: null });
  });
});
