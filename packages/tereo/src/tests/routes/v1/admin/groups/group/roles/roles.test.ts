// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../../../../../../utils/defaultOrganization.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createGroup } from "../../../../../../../utils/groups.js";
import db from "../../../../../../../utils/db/index.js";
import { randomUUID } from "node:crypto";
import {
  HTTP_STATUS,
  NON_EXISTENT_UUID,
} from "../../../../../../support/auth/constants.js";
import {
  createTestRole,
  createTestUser,
} from "../../../../../../support/auth/users.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../../../../support/principals.js";
import {
  adminApi,
  deleteGroups,
  ensureGroupPermission,
  GROUP_PERMISSION,
  groupSlug,
  postGroup,
  PROVISIONING,
  roleGranting,
  type ApiGroup,
} from "../../../../../../support/groups.js";

const groupIds: string[] = [];
let admin: string;

const track = (group: ApiGroup) => {
  groupIds.push(group.id);
  return group;
};

beforeAll(async () => {
  await ensureDefaultOrganization();
  await ensureGroupPermission();
  admin = await getTestPrincipalToken({
    permissions: ["groups.admin", GROUP_PERMISSION],
  });
});

afterAll(async () => {
  await deleteGroups(groupIds);
});

describe("/v1/admin/groups/:id/roles", () => {
  it("replaces the roles, reporting what was added and removed", async () => {
    const [r1, r2] = [await roleGranting(), await roleGranting()];
    const group = track(await postGroup(admin, { roleIds: [r1.id] }));

    const res = await adminApi("PUT", `/groups/${group.id}/roles`, admin, {
      roleIds: [r2.id],
    });
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(res.body).toEqual({
      roles: [
        {
          id: r2.id,
          name: r2.name,
          displayName: r2.displayName,
          serviceId: null,
        },
      ],
      added: [r2.id],
      removed: [r1.id],
    });

    const list = await adminApi("GET", `/groups/${group.id}/roles`, admin);
    expect(list.status).toBe(HTTP_STATUS.OK);
    expect(list.body.data.map((r: { id: string }) => r.id)).toEqual([r2.id]);
  });

  it("gives current members a role added to the group", async () => {
    const group = track(await postGroup(admin));
    const user = (await createTestUser()).id;
    await adminApi("POST", `/groups/${group.id}/members`, admin, {
      userIds: [user],
    });
    const role = await roleGranting();

    await adminApi("PUT", `/groups/${group.id}/roles`, admin, {
      roleIds: [role.id],
    });
    const perms = await db.roles.getUserPermissions(user);
    expect(perms).toContain(GROUP_PERMISSION);
  });

  it("returns 400 unknown_role for a missing role", async () => {
    const group = track(await postGroup(admin));
    const res = await adminApi("PUT", `/groups/${group.id}/roles`, admin, {
      roleIds: [NON_EXISTENT_UUID],
    });
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.body.error).toBe("unknown_role");
  });

  it("returns 403 for a system role on an organization's group", async () => {
    const orgId = await ensureTestOrganization(`roles-${randomUUID()}`);
    const group = track(await postGroup(admin, { organizationId: orgId }));
    const systemRole = await createTestRole({ isSystem: true });
    const res = await adminApi("PUT", `/groups/${group.id}/roles`, admin, {
      roleIds: [systemRole.id],
    });
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("returns 409 managed_by_provisioning for a provisioned group", async () => {
    const { group } = await db.$transaction((tx) =>
      createGroup(
        PROVISIONING,
        { organizationId: null, slug: groupSlug("prov"), name: "Provisioned" },
        tx
      )
    );
    groupIds.push(group.id);
    const res = await adminApi("PUT", `/groups/${group.id}/roles`, admin, {
      roleIds: [],
    });
    expect(res.status).toBe(HTTP_STATUS.CONFLICT);
    expect(res.body.error).toBe("managed_by_provisioning");
  });

  it("returns 400 invalid_request for a non-UUID role id", async () => {
    const group = track(await postGroup(admin));
    const res = await adminApi("PUT", `/groups/${group.id}/roles`, admin, {
      roleIds: ["x"],
    });
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.body.error).toBe("invalid_request");
  });
});
