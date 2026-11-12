// @module-tag int
// @module-tag auth
import { makeUser, tag } from "../../../../../support/scimUsers.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { pushGroup } from "../../../../../support/scim.js";
import { beforeAll, describe, expect, it } from "vitest";
import db from "../../../../../../utils/db/index.js";
import { randomUUID } from "node:crypto";
import {
  entraAddMembersPatch,
  entraRemoveMembersPatch,
  entraRenameGroupPatch,
} from "../../../../../fixtures/scim/entra.js";
import {
  asMembers,
  bodyMemberIds,
  groupAuditActions,
  groupEventCount,
  managedUser,
  memberIds,
  orgConnection,
  patchGroup,
  patchOps,
  skippedIds,
} from "../../../../../support/scimGroups.js";
import {
  oktaAddMembersPatch,
  oktaRemoveMemberPatch,
  oktaRenameGroupPatch,
} from "../../../../../fixtures/scim/okta.js";
import {
  ensureGroupPermission,
  GROUP_PERMISSION,
  passwordOnlyToken,
  roleGranting,
} from "../../../../../support/groups.js";

const FIXTURE_IDS = [
  "0198f2a4-0000-7000-8000-000000000001",
  "0198f2a4-0000-7000-8000-000000000002",
  "0198f2a4-0000-7000-8000-000000000003",
];

/** A captured request shape with its placeholder user ids swapped for real ones. */
const withIds = (fixture: unknown, ids: string[]) =>
  JSON.parse(
    FIXTURE_IDS.reduce(
      (text, from, i) => text.replaceAll(from, ids[i] ?? from),
      JSON.stringify(fixture)
    )
  );

beforeAll(async () => {
  await ensureGroupPermission();
});

describe("PATCH /scim/v2/Groups/:id", () => {
  it("handles Okta's add, remove-by-selector and rename", async () => {
    const c = await orgConnection();
    const [a, b, d] = [
      await managedUser(c),
      await managedUser(c),
      await managedUser(c),
    ];
    const pushed = await pushGroup(c.token, {
      displayName: `Okta ${tag()}`,
      members: asMembers(a.id, b.id),
    });
    const id = pushed.body.id;

    const added = await patchGroup(
      c.token,
      id,
      withIds(oktaAddMembersPatch, [a.id, b.id, d.id])
    );
    expect(added.status).toBe(200);
    expect(bodyMemberIds(added.body)).toEqual([a.id, b.id, d.id].sort());

    const removed = await patchGroup(
      c.token,
      id,
      withIds(oktaRemoveMemberPatch, [a.id, b.id, d.id])
    );
    expect(bodyMemberIds(removed.body)).toEqual([a.id, d.id].sort());

    const renamed = await patchGroup(c.token, id, oktaRenameGroupPatch);
    expect(renamed.body.displayName).toBe("Platform Eng");
    expect(await memberIds(id)).toEqual([a.id, d.id].sort());
  });

  it("handles Entra's capitalised Add, Remove with values and Replace displayName", async () => {
    const c = await orgConnection();
    const [a, b, d] = [
      await managedUser(c),
      await managedUser(c),
      await managedUser(c),
    ];
    const pushed = await pushGroup(c.token, {
      displayName: `Entra ${tag()}`,
      members: asMembers(a.id, b.id),
    });
    const id = pushed.body.id;

    const added = await patchGroup(
      c.token,
      id,
      withIds(entraAddMembersPatch, [a.id, b.id, d.id])
    );
    expect(bodyMemberIds(added.body)).toEqual([a.id, b.id, d.id].sort());

    const removed = await patchGroup(
      c.token,
      id,
      withIds(entraRemoveMembersPatch, [a.id, b.id, d.id])
    );
    expect(bodyMemberIds(removed.body)).toEqual([d.id]);

    const renamed = await patchGroup(c.token, id, entraRenameGroupPatch);
    expect(renamed.body.displayName).toBe("Platform Eng");
  });

  it("replaces members, clears them, and sets or clears the externalId", async () => {
    const c = await orgConnection();
    const [a, b] = [await managedUser(c), await managedUser(c)];
    const pushed = await pushGroup(c.token, {
      displayName: `Ops ${tag()}`,
      externalId: "ext-1",
      members: asMembers(a.id),
    });
    const id = pushed.body.id;

    const replaced = await patchGroup(
      c.token,
      id,
      patchOps({ op: "replace", path: "members", value: asMembers(b.id) })
    );
    expect(bodyMemberIds(replaced.body)).toEqual([b.id]);

    const ext = await patchGroup(
      c.token,
      id,
      patchOps({ op: "add", path: "externalId", value: "ext-2" })
    );
    expect(ext.body.externalId).toBe("ext-2");
    const noExt = await patchGroup(
      c.token,
      id,
      patchOps({ op: "remove", path: "externalId" })
    );
    expect(noExt.body).not.toHaveProperty("externalId");

    const cleared = await patchGroup(
      c.token,
      id,
      patchOps({ op: "remove", path: "members" })
    );
    expect(cleared.body.members).toEqual([]);
    expect(await memberIds(id)).toEqual([]);
  });

  it("applies a path-less object value: add appends members, replace sets them", async () => {
    const c = await orgConnection();
    const [a, b] = [await managedUser(c), await managedUser(c)];
    const pushed = await pushGroup(c.token, {
      displayName: `Obj ${tag()}`,
      members: asMembers(a.id),
    });
    const id = pushed.body.id;
    const appended = await patchGroup(
      c.token,
      id,
      patchOps({ op: "add", value: { members: asMembers(b.id) } })
    );
    expect(bodyMemberIds(appended.body)).toEqual([a.id, b.id].sort());
    const set = await patchGroup(
      c.token,
      id,
      patchOps({
        op: "replace",
        value: { members: asMembers(b.id), displayName: "Set" },
      })
    );
    expect(bodyMemberIds(set.body)).toEqual([b.id]);
    expect(set.body.displayName).toBe("Set");
  });

  it("is a no-op 200 to remove a non-member", async () => {
    const c = await orgConnection();
    const [a, stranger] = [await managedUser(c), await managedUser(c)];
    const pushed = await pushGroup(c.token, {
      displayName: `Nop ${tag()}`,
      members: asMembers(a.id),
    });
    const id = pushed.body.id;
    const audit = await groupAuditActions(id);
    const events = await groupEventCount(id);
    const r = await patchGroup(
      c.token,
      id,
      patchOps({
        op: "remove",
        path: `members[value eq "${stranger.id}"]`,
      })
    );
    expect(r.status).toBe(200);
    expect(bodyMemberIds(r.body)).toEqual([a.id]);
    expect(await groupAuditActions(id)).toEqual(audit);
    expect(await groupEventCount(id)).toBe(events);
    expect(r.body.meta.lastModified).toBe(pushed.body.meta.lastModified);
  });

  it("answers 200 with the resource when nothing in the request applies", async () => {
    const c = await orgConnection();
    const a = await managedUser(c);
    const pushed = await pushGroup(c.token, {
      displayName: `Empty ${tag()}`,
      members: asMembers(a.id),
    });
    const audit = await groupAuditActions(pushed.body.id);
    const events = await groupEventCount(pushed.body.id);
    const r = await patchGroup(
      c.token,
      pushed.body.id,
      patchOps({ op: "replace", value: { unknownAttribute: "x" } })
    );
    expect(r.status).toBe(200);
    expect(bodyMemberIds(r.body)).toEqual([a.id]);
    expect(await groupAuditActions(pushed.body.id)).toEqual(audit);
    expect(await groupEventCount(pushed.body.id)).toBe(events);
  });

  it("adds a member named twice once, in one request", async () => {
    const c = await orgConnection();
    const a = await managedUser(c);
    const pushed = await pushGroup(c.token, { displayName: `Dup ${tag()}` });
    const r = await patchGroup(
      c.token,
      pushed.body.id,
      patchOps({
        op: "add",
        path: "members",
        value: [{ value: a.id }, { value: a.id.toUpperCase() }],
      })
    );
    expect(r.status).toBe(200);
    expect(bodyMemberIds(r.body)).toEqual([a.id]);
    expect(await prisma.groupMember.count({ where: { userId: a.id } })).toBe(1);
  });

  it("applies operations in order: add then remove leaves the user out, remove then add keeps them", async () => {
    const c = await orgConnection();
    const [a, b] = [await managedUser(c), await managedUser(c)];
    const pushed = await pushGroup(c.token, {
      displayName: `Ord ${tag()}`,
      members: asMembers(b.id),
    });
    const id = pushed.body.id;
    await patchGroup(
      c.token,
      id,
      patchOps(
        { op: "add", path: "members", value: asMembers(a.id) },
        { op: "remove", path: `members[value eq "${a.id}"]` }
      )
    );
    expect(await memberIds(id)).toEqual([b.id]);

    await patchGroup(
      c.token,
      id,
      patchOps(
        { op: "remove", path: `members[value eq "${b.id}"]` },
        { op: "add", path: "members", value: asMembers(b.id) }
      )
    );
    expect(await memberIds(id)).toEqual([b.id]);
  });

  it("the last of several displayName operations wins", async () => {
    const c = await orgConnection();
    const pushed = await pushGroup(c.token, { displayName: `Name ${tag()}` });
    const r = await patchGroup(
      c.token,
      pushed.body.id,
      patchOps(
        { op: "replace", path: "displayName", value: "First" },
        { op: "replace", path: "displayName", value: "Second" }
      )
    );
    expect(r.body.displayName).toBe("Second");
  });

  it("moves meta.lastModified on a member-only change", async () => {
    const c = await orgConnection();
    const a = await managedUser(c);
    const pushed = await pushGroup(c.token, { displayName: `LM ${tag()}` });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const r = await patchGroup(
      c.token,
      pushed.body.id,
      patchOps({ op: "add", path: "members", value: asMembers(a.id) })
    );
    expect(Date.parse(r.body.meta.lastModified)).toBeGreaterThan(
      Date.parse(pushed.body.meta.lastModified)
    );
  });

  it("records a managed user outside the organization, and a later PATCH adds them once they join", async () => {
    const c = await orgConnection();
    const outsider = await managedUser(c, { inOrg: false });
    const other = await managedUser(c);
    const pushed = await pushGroup(c.token, { displayName: `Skip ${tag()}` });
    const id = pushed.body.id;

    const first = await patchGroup(
      c.token,
      id,
      patchOps({ op: "add", path: "members", value: asMembers(outsider.id) })
    );
    expect(first.status).toBe(200);
    expect(bodyMemberIds(first.body)).toEqual([]);
    expect(await skippedIds(id)).toEqual([outsider.id]);

    await prisma.organizationMember.create({
      data: { organizationId: c.organizationId, userId: outsider.id },
    });
    const second = await patchGroup(
      c.token,
      id,
      patchOps({ op: "add", path: "members", value: asMembers(other.id) })
    );
    expect(bodyMemberIds(second.body)).toEqual([outsider.id, other.id].sort());
    expect(await skippedIds(id)).toEqual([]);
  });

  it("drops a recorded skip when the directory removes that member", async () => {
    const c = await orgConnection();
    const outsider = await managedUser(c, { inOrg: false });
    const pushed = await pushGroup(c.token, {
      displayName: `Drop ${tag()}`,
      members: asMembers(outsider.id),
    });
    expect(await skippedIds(pushed.body.id)).toEqual([outsider.id]);
    await patchGroup(
      c.token,
      pushed.body.id,
      patchOps({
        op: "remove",
        path: `members[value eq "${outsider.id}"]`,
      })
    );
    expect(await skippedIds(pushed.body.id)).toEqual([]);
  });

  it("changes members of an admin-archived group without granting anything until it is restored", async () => {
    const c = await orgConnection();
    const user = await managedUser(c);
    const role = await roleGranting();
    const pushed = await pushGroup(c.token, { displayName: `Arch ${tag()}` });
    const id = pushed.body.id;
    await prisma.groupRole.create({
      data: { groupId: id, roleId: role.id, addedBy: user.id },
    });
    await prisma.group.update({
      where: { id },
      data: { archivedAt: new Date() },
    });

    const r = await patchGroup(
      c.token,
      id,
      patchOps({ op: "add", path: "members", value: asMembers(user.id) })
    );
    expect(r.status).toBe(200);
    expect(await memberIds(id)).toEqual([user.id]);
    expect(
      await db.roles.getUserPermissions(user.id, c.organizationId)
    ).not.toContain(GROUP_PERMISSION);

    await prisma.group.update({ where: { id }, data: { archivedAt: null } });
    expect(
      await db.roles.getUserPermissions(user.id, c.organizationId)
    ).toContain(GROUP_PERMISSION);
  });

  it("revokes the password-only token of a member added to a group with a two-factor role", async () => {
    const c = await orgConnection();
    const user = await managedUser(c);
    const role = await roleGranting([GROUP_PERMISSION], { requires2fa: true });
    const pushed = await pushGroup(c.token, { displayName: `2FA ${tag()}` });
    await prisma.groupRole.create({
      data: { groupId: pushed.body.id, roleId: role.id, addedBy: user.id },
    });
    const jti = await passwordOnlyToken(user.id);

    const r = await patchGroup(
      c.token,
      pushed.body.id,
      patchOps({ op: "add", path: "members", value: asMembers(user.id) })
    );
    expect(r.status).toBe(200);
    const token = await prisma.accessToken.findUniqueOrThrow({
      where: { jti },
    });
    expect(token.revokedAt).not.toBeNull();
  });

  it("rejects unsupported paths, operations and values", async () => {
    const c = await orgConnection();
    const pushed = await pushGroup(c.token, { displayName: `Bad ${tag()}` });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ op: "replace", path: "description", value: "x" }, "invalidPath"],
      [{ op: "remove", path: "displayName" }, "invalidValue"],
      [{ op: "move", path: "members" }, "invalidSyntax"],
      [{ op: "add", path: "members", value: "nope" }, "invalidValue"],
    ];
    for (const [operation, scimType] of cases) {
      const r = await patchGroup(c.token, pushed.body.id, patchOps(operation));
      expect(r.status, JSON.stringify(operation)).toBe(400);
      expect(r.body).toMatchObject({ scimType });
    }
  });

  it("is 404 for another connection's group, a local group and a non-uuid, leaving the other group untouched", async () => {
    const a = await orgConnection();
    const b = await orgConnection();
    const victim = await managedUser(a);
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
    const body = patchOps(
      { op: "add", path: "members", value: asMembers(victim.id) },
      { op: "replace", path: "displayName", value: "Hijacked" }
    );
    expect((await patchGroup(a.token, theirs.body.id, body)).status).toBe(404);
    expect((await patchGroup(a.token, local.id, body)).status).toBe(404);
    expect((await patchGroup(a.token, "not-a-uuid", body)).status).toBe(404);
    expect((await patchGroup(a.token, randomUUID(), body)).status).toBe(404);

    expect(await memberIds(theirs.body.id)).toEqual([]);
    expect(await memberIds(local.id)).toEqual([]);
    expect(
      (await prisma.group.findUniqueOrThrow({ where: { id: theirs.body.id } }))
        .name
    ).toBe(theirs.body.displayName);
  });
});
