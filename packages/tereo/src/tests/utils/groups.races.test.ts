// @module-tag int
// @module-tag auth
// @module-tag race
import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { addMembers, createGroup, setGroupRoles } from "../../utils/groups.js";
import { BASE_URL, HTTP_STATUS } from "../support/auth/constants.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestUser } from "../support/auth/users.js";
import db from "../../utils/db/index.js";
import { randomUUID } from "node:crypto";
import {
  getTestPrincipalToken,
  ensureTestOrganization,
} from "../support/principals.js";
import {
  deleteGroups,
  ensureGroupPermission,
  GROUP_PERMISSION,
  groupSlug,
  joinOrg,
  PROVISIONING,
  roleGranting,
} from "../support/groups.js";

const groupIds: string[] = [];

const newGroup = async (organizationId: string | null) => {
  const { group } = await db.$transaction((tx) =>
    createGroup(
      PROVISIONING,
      { organizationId, slug: groupSlug("race"), name: "Race group" },
      tx
    )
  );
  groupIds.push(group.id);
  return group;
};

beforeAll(async () => {
  // Events are emitted in-process, under the default organization.
  await ensureDefaultOrganization();
  await ensureGroupPermission();
});

afterAll(async () => {
  await deleteGroups(groupIds);
});

describe("group races", () => {
  it("concurrent setGroupRoles and addMembers on one group both apply", async () => {
    const group = await newGroup(null);
    const first = await createTestUser();
    const second = await createTestUser();
    await db.$transaction((tx) =>
      addMembers(PROVISIONING, group.id, [first.id], tx)
    );
    const role = await roleGranting();

    const [roles, members] = await Promise.all([
      db.$transaction((tx) =>
        setGroupRoles(PROVISIONING, group.id, [role.id], tx)
      ),
      db.$transaction((tx) =>
        addMembers(PROVISIONING, group.id, [second.id], tx)
      ),
    ]);

    expect(roles.added).toEqual([role.id]);
    expect(members.added).toEqual([second.id]);
    expect(await db.groups.getRoleIds(group.id)).toEqual([role.id]);
    expect((await db.groups.getMemberIds(group.id)).sort()).toEqual(
      [first.id, second.id].sort()
    );
    for (const user of [first, second]) {
      expect(await db.roles.getUserPermissions(user.id)).toContain(
        GROUP_PERMISSION
      );
    }
  });

  it("addMembers racing org member removal leaves no org-group membership for a non-member", async () => {
    const token = await getTestPrincipalToken({
      permissions: ["organizations.write"],
    });
    for (let i = 0; i < 5; i++) {
      const org = await ensureTestOrganization(`group-race-${randomUUID()}`);
      const group = await newGroup(org);
      const user = await createTestUser();
      await joinOrg(org, user.id);

      const [added, removed] = await Promise.allSettled([
        db.$transaction((tx) =>
          addMembers(PROVISIONING, group.id, [user.id], tx)
        ),
        fetch(`${BASE_URL}/v1/admin/organizations/${org}/members/${user.id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);

      expect(removed.status).toBe("fulfilled");
      if (removed.status === "fulfilled") {
        expect(removed.value.status).toBe(HTTP_STATUS.NO_CONTENT);
      }
      if (added.status === "rejected") {
        expect((added.reason as { code?: string }).code).toBe("not_org_member");
      }
      expect(await db.groups.getMemberIds(group.id)).toEqual([]);
    }
  });
});
