// @module-tag int
// @module-tag auth
// @module-tag race
import { ensureDefaultOrganization } from "../../../../../../../utils/defaultOrganization.js";
import { getTestPrincipalToken } from "../../../../../../support/principals.js";
import { NON_EXISTENT_UUID } from "../../../../../../support/auth/constants.js";
import { createTestUser } from "../../../../../../support/auth/users.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import db from "../../../../../../../utils/db/index.js";
import {
  getGroup,
  globalConnection,
  managedUser,
  orgConnection,
  pushedGroup,
} from "../../../../../../support/scimGroups.js";
import {
  adminApi,
  deleteGroups,
  joinOrg,
  postGroup,
} from "../../../../../../support/groups.js";

let admin: string;

beforeAll(async () => {
  await ensureDefaultOrganization();
  admin = await getTestPrincipalToken({ permissions: ["groups.admin"] });
});

const unlink = (id: string, token = admin) =>
  adminApi("DELETE", `/groups/${id}/scim`, token);

const orgAdminToken = async (organizationId: string) => {
  const user = await createTestUser();
  await joinOrg(organizationId, user.id, "admin");
  return await getTestPrincipalToken({ userId: user.id, permissions: [] });
};

describe("DELETE /v1/admin/groups/:id/scim", () => {
  it("unlinks: 204, sources local, members kept, SCIM 404, admin edits work, second unlink 404", async () => {
    const c = await orgConnection();
    const member = await managedUser(c);
    const extra = await managedUser(c);
    const { id } = await pushedGroup(c, [member.id]);

    const res = await unlink(id);
    expect(res.status).toBe(204);

    const group = await prisma.group.findUniqueOrThrow({ where: { id } });
    expect(group).toMatchObject({
      definitionSource: "local",
      membershipSource: "local",
    });
    expect(await prisma.scimGroup.count({ where: { groupId: id } })).toBe(0);
    expect(
      (await prisma.groupMember.findMany({ where: { groupId: id } })).map(
        (m) => m.userId
      )
    ).toEqual([member.id]);
    expect((await getGroup(c.token, id)).status).toBe(404);

    const added = await adminApi("POST", `/groups/${id}/members`, admin, {
      userIds: [extra.id],
    });
    expect(added.status).toBe(200);
    const renamed = await adminApi("PATCH", `/groups/${id}`, admin, {
      name: "Ours now",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.managedBy).toBeNull();

    expect((await unlink(id)).status).toBe(404);
    await deleteGroups([id]);
  });

  it("audits the unlink with the admin as actor, once", async () => {
    const c = await orgConnection();
    const { id } = await pushedGroup(c, []);
    await unlink(id);

    const entries = await prisma.auditLogEntry.findMany({
      where: { entityType: "Group", entityId: id },
    });
    const unlinks = entries.filter(
      (e) =>
        (e.metadata as { action?: string } | null)?.action === "scim_unlinked"
    );
    expect(unlinks).toHaveLength(1);
    expect(unlinks[0].metadata).toMatchObject({ reason: "admin" });
    expect(unlinks[0].userId).not.toBe(null);
    await deleteGroups([id]);
  });

  it("returns 404 for a local group", async () => {
    const local = await postGroup(admin);
    expect((await unlink(local.id)).status).toBe(404);
    await deleteGroups([local.id]);
  });

  it("returns 404 for a missing group to a groups.write holder", async () => {
    expect((await unlink(NON_EXISTENT_UUID)).status).toBe(404);
  });

  it("lets an organization admin unlink their organization's pushed group", async () => {
    const c = await orgConnection();
    const { id } = await pushedGroup(c, []);
    const res = await unlink(id, await orgAdminToken(c.organizationId));
    expect(res.status).toBe(204);
    await deleteGroups([id]);
  });

  it("gives an organization admin the uniform 403 for a global pushed group", async () => {
    const c = await globalConnection();
    const { id } = await pushedGroup(c, []);
    const other = await orgConnection();
    const res = await unlink(id, await orgAdminToken(other.organizationId));
    expect(res.status).toBe(403);
    expect(await prisma.scimGroup.count({ where: { groupId: id } })).toBe(1);
  });

  it("answers 404, not 500, when the link is removed while the request waits on the group lock", async () => {
    const c = await orgConnection();
    const { id } = await pushedGroup(c, []);

    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const held = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.$transaction(async (tx) => {
      await db.groups.lockGroup(id, tx);
      locked();
      await hold;
      const link = await db.scimGroups.getLinkByGroup(id, tx);
      await db.scimGroups.deleteLink(link!.id, tx);
    });
    await held;

    const pending = unlink(id);
    await new Promise((r) => setTimeout(r, 500));
    release();
    await holder;

    const res = await pending;
    expect(res.status).toBe(404);
    await deleteGroups([id]);
  });
});
