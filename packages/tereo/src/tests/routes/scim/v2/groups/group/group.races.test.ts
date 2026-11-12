// @module-tag int
// @module-tag auth
// @module-tag race
import { holdLocks, waitForLockWait } from "../../../../../support/dbLocks.js";
import { removeFromOrgGroupsTx } from "../../../../../../utils/groups.js";
import { SYSTEM_USER_ID } from "../../../../../../definitions/index.js";
import { pushGroup, scimFetch } from "../../../../../support/scim.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { tag } from "../../../../../support/scimUsers.js";
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
} from "../../../../../support/scimGroups.js";

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
});
