// @module-tag int
// @module-tag auth
// @module-tag race
import { holdLocks, waitForLockWait } from "../../../../../support/dbLocks.js";
import { removeFromOrgGroupsTx } from "../../../../../../utils/groups.js";
import { SYSTEM_USER_ID } from "../../../../../../definitions/index.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import db from "../../../../../../utils/db/index.js";
import { describe, expect, it } from "vitest";
import {
  asMembers,
  bodyMemberIds,
  managedUser,
  memberIds,
  orgConnection,
  patchGroup,
  patchOps,
  putGroup,
  skippedIds,
  waitForAuthorityLockWait,
} from "../../../../../support/scimGroups.js";
import {
  makeUser,
  managedWith,
  tag,
} from "../../../../../support/scimUsers.js";
import {
  createScimConnection,
  pushGroup,
  scimFetch,
  setGroupsTarget,
} from "../../../../../support/scim.js";

const sorted = (ids: string[]) => [...ids].sort();

describe("SCIM group changes racing", { tags: ["race"] }, () => {
  it("two PATCHes adding overlapping members both succeed with the union", async () => {
    const c = await orgConnection();
    const users = await Promise.all(
      Array.from({ length: 4 }, () => managedUser(c))
    );
    const [a, b, d, e] = users.map((u) => u.id);
    const pushed = await pushGroup(c.token, { displayName: `Ov ${tag()}` });
    const id = pushed.body.id;

    const [first, second] = await Promise.all([
      patchGroup(
        c.token,
        id,
        patchOps({ op: "add", path: "members", value: asMembers(a, b, d) })
      ),
      patchGroup(
        c.token,
        id,
        patchOps({ op: "add", path: "members", value: asMembers(b, d, e) })
      ),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await memberIds(id)).toEqual(sorted([a, b, d, e]));
  });

  it("an add concurrent with the user leaving the organization ends with them not a member", async () => {
    const c = await orgConnection();
    const user = await managedUser(c);
    const pushed = await pushGroup(c.token, { displayName: `Leave ${tag()}` });
    const id = pushed.body.id;

    const release = await holdLocks(async (tx) => {
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
    const patching = patchGroup(
      c.token,
      id,
      patchOps({ op: "add", path: "members", value: asMembers(user.id) })
    );
    try {
      await waitForLockWait("%pg_advisory_xact_lock%");
    } finally {
      await release();
    }
    const r = await patching;
    expect(r.status).toBe(200);
    expect(bodyMemberIds(r.body)).toEqual([]);
    expect(await memberIds(id)).toEqual([]);
    expect(await skippedIds(id)).toEqual([user.id]);
  });

  it("two concurrent PUTs end in one of the two member sets, never a mix", async () => {
    const c = await orgConnection();
    const users = await Promise.all(
      Array.from({ length: 6 }, () => managedUser(c))
    );
    const ids = users.map((u) => u.id);
    const setA = sorted(ids.slice(0, 4));
    const setB = sorted(ids.slice(2));
    const pushed = await pushGroup(c.token, { displayName: `Put ${tag()}` });
    const id = pushed.body.id;
    const body = (members: string[]) => ({
      displayName: pushed.body.displayName,
      members: asMembers(...members),
    });

    for (let round = 0; round < 5; round++) {
      const [x, y] = await Promise.all([
        putGroup(c.token, id, body(setA)),
        putGroup(c.token, id, body(setB)),
      ]);
      expect([x.status, y.status]).toEqual([200, 200]);
      const now = await memberIds(id);
      expect([setA, setB]).toContainEqual(now);
    }
  });

  it("a PATCH concurrent with the group's DELETE is applied first or finds nothing, never a 5xx", async () => {
    const c = await orgConnection();
    for (let round = 0; round < 4; round++) {
      const user = await managedUser(c);
      const pushed = await pushGroup(c.token, {
        displayName: `Del ${tag()}`,
      });
      const id = pushed.body.id;
      const [patched, deleted] = await Promise.all([
        patchGroup(
          c.token,
          id,
          patchOps(
            { op: "add", path: "members", value: asMembers(user.id) },
            { op: "replace", path: "displayName", value: `Late ${tag()}` }
          )
        ),
        scimFetch(c.token, "DELETE", `/scim/v2/Groups/${id}`),
      ]);
      expect([200, 404]).toContain(patched.status);
      expect(deleted.status).toBe(204);
      const group = await prisma.group.findUniqueOrThrow({
        where: { id },
        include: { scimLink: true },
      });
      expect(group.scimLink).toBeNull();
      expect(group.membershipSource).toBe("local");
    }
  });

  it("a member removal in a global group does not deadlock with a SCIM user write that adopts and deactivates a user", async () => {
    const c = await createScimConnection();
    await setGroupsTarget(c.connectionId, { kind: "global" });
    for (let round = 0; round < 3; round++) {
      const member = await managedWith(c);
      const free = await makeUser(`free-${tag()}@${c.domain}`);
      const pushed = await pushGroup(c.token, {
        displayName: `Gl ${tag()}`,
        members: asMembers(member.id),
      });
      // The user write queues first on the administrator guard, so it holds
      // that lock when it reaches the connection row; the group write is
      // queued behind it with the connection row already taken.
      const release = await holdLocks(
        (tx) =>
          tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('core:admin-remains', 0))`
      );
      let responses;
      try {
        const userWrite = scimFetch(
          c.token,
          "PUT",
          `/scim/v2/Users/${free.id}`,
          {
            schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
            userName: free.email,
            active: false,
            emails: [{ primary: true, value: free.email }],
            name: { givenName: "Free", familyName: "User" },
          }
        );
        await waitForLockWait("%core:admin-remains%", 10_000, 1);
        const groupWrite = patchGroup(
          c.token,
          pushed.body.id,
          patchOps({
            op: "remove",
            path: `members[value eq "${member.id}"]`,
          })
        );
        await waitForLockWait("%core:admin-remains%", 10_000, 2);
        responses = Promise.all([userWrite, groupWrite]);
      } finally {
        await release();
      }
      const [user, group] = await responses;
      expect(user.status, JSON.stringify(user.body)).toBeLessThan(500);
      expect(group.status, JSON.stringify(group.body)).toBe(200);
    }
  });

  it("a directory removal beats a skip record an organization removal wrote while it waited", async () => {
    const c = await orgConnection();
    const user = await managedUser(c);
    const other = await managedUser(c);
    const pushed = await pushGroup(c.token, {
      displayName: `Rm ${tag()}`,
      members: asMembers(user.id),
    });
    const id = pushed.body.id;

    const release = await holdLocks(async (tx) => {
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
    let patching;
    try {
      patching = patchGroup(
        c.token,
        id,
        patchOps({ op: "remove", path: `members[value eq "${user.id}"]` })
      );
      await waitForAuthorityLockWait(user.id);
    } finally {
      await release();
    }
    expect((await patching).status).toBe(200);
    expect(await memberIds(id)).toEqual([]);
    expect(await skippedIds(id)).toEqual([]);

    await prisma.organizationMember.create({
      data: { organizationId: c.organizationId, userId: user.id },
    });
    const next = await patchGroup(
      c.token,
      id,
      patchOps({ op: "add", path: "members", value: asMembers(other.id) })
    );
    expect(bodyMemberIds(next.body)).toEqual([other.id]);
  });

  it("a PATCH adding a user concurrent with their SCIM DELETE ends with them in no pushed group", async () => {
    const c = await orgConnection();
    for (let round = 0; round < 4; round++) {
      const user = await managedUser(c);
      const pushed = await pushGroup(c.token, { displayName: `Gone ${tag()}` });
      const id = pushed.body.id;

      // Whichever of the two reaches the user's authority lock second runs
      // after the other; round parity chooses which one that is.
      const release = await holdLocks((tx) =>
        db.users.lockAuthority(user.id, tx)
      );
      let responses;
      try {
        const add = () =>
          patchGroup(
            c.token,
            id,
            patchOps({ op: "add", path: "members", value: asMembers(user.id) })
          );
        const remove = () =>
          scimFetch(c.token, "DELETE", `/scim/v2/Users/${user.id}`);
        const [first, second] = round % 2 === 0 ? [add, remove] : [remove, add];
        const firstResponse = first();
        await waitForAuthorityLockWait(user.id);
        const secondResponse = second();
        await new Promise((r) => setTimeout(r, 100));
        responses = Promise.all([firstResponse, secondResponse]);
      } finally {
        await release();
      }
      const [x, y] = await responses;
      expect(x.status, JSON.stringify(x.body)).toBeLessThan(500);
      expect(y.status, JSON.stringify(y.body)).toBeLessThan(500);
      expect(await memberIds(id)).toEqual([]);
      expect(await skippedIds(id)).toEqual([]);
    }
  });

  it("a SCIM user DELETE and a member removal in the same global group do not deadlock", async () => {
    const c = await createScimConnection();
    await setGroupsTarget(c.connectionId, { kind: "global" });
    for (let round = 0; round < 3; round++) {
      const leaving = await managedWith(c);
      const staying = await managedWith(c);
      const pushed = await pushGroup(c.token, {
        displayName: `Gl ${tag()}`,
        members: asMembers(leaving.id, staying.id),
      });
      const id = pushed.body.id;
      // The DELETE holds the group row and waits on the administrator guard;
      // the group write queues behind that row, so the guard must come after
      // the group on both paths.
      const release = await holdLocks(
        (tx) =>
          tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('core:admin-remains', 0))`
      );
      let responses;
      try {
        const deleting = scimFetch(
          c.token,
          "DELETE",
          `/scim/v2/Users/${leaving.id}`
        );
        await waitForLockWait("%core:admin-remains%", 10_000, 1);
        const removing = patchGroup(
          c.token,
          id,
          patchOps({
            op: "remove",
            path: `members[value eq "${staying.id}"]`,
          })
        );
        await new Promise((r) => setTimeout(r, 150));
        responses = Promise.all([deleting, removing]);
      } finally {
        await release();
      }
      const [deleted, removed] = await responses;
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(204);
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      expect(await memberIds(id)).toEqual([]);
    }
  });
});
