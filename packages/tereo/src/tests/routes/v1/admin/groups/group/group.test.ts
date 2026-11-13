// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../../../../../utils/defaultOrganization.js";
import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { createTestUser } from "../../../../../support/auth/users.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createGroup } from "../../../../../../utils/groups.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { scimFetch } from "../../../../../support/scim.js";
import db from "../../../../../../utils/db/index.js";
import {
  HTTP_STATUS,
  NON_EXISTENT_UUID,
} from "../../../../../support/auth/constants.js";
import {
  orgConnection,
  pushedGroup,
} from "../../../../../support/scimGroups.js";
import {
  joinOrg,
  roleGranting,
  ensureGroupPermission,
  GROUP_PERMISSION,
} from "../../../../../support/groups.js";
import {
  adminApi,
  deleteGroups,
  groupSlug,
  postGroup,
  PROVISIONING,
  type ApiGroup,
} from "../../../../../support/groups.js";

const groupIds: string[] = [];
let admin: string;

const track = (group: ApiGroup) => {
  groupIds.push(group.id);
  return group;
};

const provisionedGroup = async () => {
  const { group } = await db.$transaction((tx) =>
    createGroup(
      PROVISIONING,
      { organizationId: null, slug: groupSlug("prov"), name: "Provisioned" },
      tx
    )
  );
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

describe("GET /v1/admin/groups/:id", () => {
  it("returns the group with its member count", async () => {
    const group = track(await postGroup(admin));
    const res = await adminApi("GET", `/groups/${group.id}`, admin);
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(res.body).toEqual(group);
  });

  it("returns 404 for a missing group to a groups.read holder", async () => {
    const res = await adminApi("GET", `/groups/${NON_EXISTENT_UUID}`, admin);
    expect(res.status).toBe(HTTP_STATUS.NOT_FOUND);
  });
});

describe("PATCH /v1/admin/groups/:id", () => {
  it("updates slug, name and description", async () => {
    const group = track(await postGroup(admin));
    const slug = groupSlug("renamed");
    const res = await adminApi("PATCH", `/groups/${group.id}`, admin, {
      slug,
      name: "Renamed",
      description: null,
    });
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(res.body).toMatchObject({ id: group.id, slug, name: "Renamed" });
  });

  it("returns 400 for an empty body", async () => {
    const group = track(await postGroup(admin));
    const res = await adminApi("PATCH", `/groups/${group.id}`, admin, {});
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });

  it("returns 409 managed_by_provisioning for a provisioned group", async () => {
    const group = await provisionedGroup();
    const res = await adminApi("PATCH", `/groups/${group.id}`, admin, {
      name: "Hand edit",
    });
    expect(res.status).toBe(HTTP_STATUS.CONFLICT);
    expect(res.body.error).toBe("managed_by_provisioning");
  });

  it("returns 409 resource_archived for an archived group", async () => {
    const group = track(await postGroup(admin));
    await adminApi("POST", `/groups/${group.id}/archive`, admin);
    const res = await adminApi("PATCH", `/groups/${group.id}`, admin, {
      name: "Late",
    });
    expect(res.status).toBe(HTTP_STATUS.CONFLICT);
    expect(res.body.error).toBe("resource_archived");
  });
});

describe("POST /v1/admin/groups/:id/archive and /restore", () => {
  it("archives and restores, returning the group each time", async () => {
    const group = track(await postGroup(admin));

    const archived = await adminApi(
      "POST",
      `/groups/${group.id}/archive`,
      admin
    );
    expect(archived.status).toBe(HTTP_STATUS.OK);
    expect(archived.body.archivedAt).toEqual(expect.any(String));

    const again = await adminApi("POST", `/groups/${group.id}/archive`, admin);
    expect(again.status).toBe(HTTP_STATUS.CONFLICT);
    expect(again.body.error).toBe("already_archived");

    const restored = await adminApi(
      "POST",
      `/groups/${group.id}/restore`,
      admin
    );
    expect(restored.status).toBe(HTTP_STATUS.OK);
    expect(restored.body.archivedAt).toBeNull();

    const notArchived = await adminApi(
      "POST",
      `/groups/${group.id}/restore`,
      admin
    );
    expect(notArchived.status).toBe(HTTP_STATUS.CONFLICT);
    expect(notArchived.body.error).toBe("not_archived");
  });

  it("returns 409 managed_by_provisioning when archiving a provisioned group", async () => {
    const group = await provisionedGroup();
    const res = await adminApi("POST", `/groups/${group.id}/archive`, admin);
    expect(res.status).toBe(HTTP_STATUS.CONFLICT);
    expect(res.body.error).toBe("managed_by_provisioning");
  });

  it("needs groups.archive, not only groups.write", async () => {
    const writer = await getTestPrincipalToken({
      permissions: ["groups.write"],
    });
    const group = track(await postGroup(admin));
    const res = await adminApi("POST", `/groups/${group.id}/archive`, writer);
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
  });
});

describe("admin edits of a SCIM-pushed group", () => {
  it("reads managedBy and the skipped count", async () => {
    const c = await orgConnection();
    const outsider = await createTestUser();
    const { id } = await pushedGroup(c, [], [outsider.id]);

    const res = await adminApi("GET", `/groups/${id}`, admin);
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(res.body).toMatchObject({
      managedBy: {
        kind: "scim",
        providerId: c.providerId,
        providerName: "SCIM IdP",
      },
      skippedMemberCount: 1,
    });
  });

  it("refuses a name change with 409 managed_by_scim but takes slug and description", async () => {
    const c = await orgConnection();
    const { id } = await pushedGroup(c, []);

    const refused = await adminApi("PATCH", `/groups/${id}`, admin, {
      name: "Renamed",
    });
    expect(refused.status).toBe(HTTP_STATUS.CONFLICT);
    expect(refused.body.error).toBe("managed_by_scim");

    const slug = groupSlug("pushed");
    const ok = await adminApi("PATCH", `/groups/${id}`, admin, {
      slug,
      description: "Ours",
    });
    expect(ok.status).toBe(HTTP_STATUS.OK);
    expect(ok.body).toMatchObject({ slug, description: "Ours" });
    expect(ok.body.managedBy).not.toBeNull();
  });

  it("lets a groups.admin set roles on, archive and restore a pushed group", async () => {
    const c = await orgConnection();
    const { id } = await pushedGroup(c, []);
    const role = await roleGranting();

    const roles = await adminApi("PUT", `/groups/${id}/roles`, admin, {
      roleIds: [role.id],
    });
    expect(roles.status).toBe(HTTP_STATUS.OK);

    const archived = await adminApi("POST", `/groups/${id}/archive`, admin);
    expect(archived.status).toBe(HTTP_STATUS.OK);
    expect(archived.body.archivedAt).not.toBeNull();
    expect(archived.body.managedBy).not.toBeNull();

    const restored = await adminApi("POST", `/groups/${id}/restore`, admin);
    expect(restored.status).toBe(HTTP_STATUS.OK);
    expect(restored.body.archivedAt).toBeNull();
  });

  it("lets an organization admin set roles on, archive and restore their organization's pushed group", async () => {
    const c = await orgConnection();
    const { id } = await pushedGroup(c, []);
    const orgAdmin = await createTestUser();
    await joinOrg(c.organizationId, orgAdmin.id, "admin");
    const token = await getTestPrincipalToken({
      userId: orgAdmin.id,
      permissions: [],
    });

    const roles = await adminApi("PUT", `/groups/${id}/roles`, token, {
      roleIds: [],
    });
    expect(roles.status).toBe(HTTP_STATUS.OK);
    expect(
      (await adminApi("POST", `/groups/${id}/archive`, token)).status
    ).toBe(HTTP_STATUS.OK);
    expect(
      (await adminApi("POST", `/groups/${id}/restore`, token)).status
    ).toBe(HTTP_STATUS.OK);
  });

  it("reports managedBy null once a SCIM delete has removed the link", async () => {
    const c = await orgConnection();
    const { id } = await pushedGroup(c, []);
    const del = await scimFetch(c.token, "DELETE", `/scim/v2/Groups/${id}`);
    expect(del.status).toBe(204);

    const res = await adminApi("GET", `/groups/${id}`, admin);
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(res.body.managedBy).toBeNull();
    expect(res.body.archivedAt).not.toBeNull();
    expect(await prisma.scimGroup.count({ where: { groupId: id } })).toBe(0);
  });
});
