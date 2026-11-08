// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../../../../utils/defaultOrganization.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../utils/db/prisma.js";
import { randomUUID } from "node:crypto";
import {
  HTTP_STATUS,
  NON_EXISTENT_UUID,
} from "../../../../support/auth/constants.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../../support/principals.js";
import {
  adminApi,
  deleteGroups,
  ensureGroupPermission,
  GROUP_PERMISSION,
  groupSlug,
  joinOrg,
  postGroup,
  roleGranting,
  type ApiGroup,
} from "../../../../support/groups.js";

const groupIds: string[] = [];
let admin: string;

const track = (group: ApiGroup) => {
  groupIds.push(group.id);
  return group;
};

const newOrg = () => ensureTestOrganization(`groups-api-${randomUUID()}`);

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

describe("POST /v1/admin/groups", () => {
  it("creates a global group and returns 201 with its shape", async () => {
    const slug = groupSlug("create");
    const res = await adminApi("POST", "/groups", admin, {
      slug,
      name: "Support",
      description: "First line",
    });

    expect(res.status).toBe(HTTP_STATUS.CREATED);
    track(res.body);
    expect(res.body).toEqual({
      id: expect.any(String),
      organizationId: null,
      slug,
      name: "Support",
      description: "First line",
      definitionSource: "local",
      membershipSource: "local",
      unprovisionedAt: null,
      archivedAt: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      memberCount: 0,
    });
  });

  it("creates an organization's group with roles and writes an audit entry", async () => {
    const orgId = await newOrg();
    const role = await roleGranting();
    const group = track(
      await postGroup(admin, { organizationId: orgId, roleIds: [role.id] })
    );

    expect(group.organizationId).toBe(orgId);
    const held = await prisma.groupRole.findMany({
      where: { groupId: group.id },
    });
    expect(held.map((r) => r.roleId)).toEqual([role.id]);
    const entry = await prisma.auditLogEntry.findFirst({
      where: { entityId: group.id, entityType: "Group", action: "CREATE" },
    });
    expect(entry?.organizationId).toBe(orgId);
  });

  it("returns 400 invalid_request for a bad slug", async () => {
    const res = await adminApi("POST", "/groups", admin, {
      slug: "Not A Slug",
      name: "x",
    });
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.body.error).toBe("invalid_request");
  });

  it("returns 409 group_slug_taken for a slug already used in the scope", async () => {
    const group = track(await postGroup(admin));
    const res = await adminApi("POST", "/groups", admin, {
      slug: group.slug,
      name: "Again",
    });
    expect(res.status).toBe(HTTP_STATUS.CONFLICT);
    expect(res.body.error).toBe("group_slug_taken");
  });

  it("allows the same slug in another scope", async () => {
    const group = track(await postGroup(admin));
    const orgGroup = track(
      await postGroup(admin, {
        slug: group.slug,
        organizationId: await newOrg(),
      })
    );
    expect(orgGroup.slug).toBe(group.slug);
  });

  it("returns 400 unknown_organization for a missing organization", async () => {
    const res = await adminApi("POST", "/groups", admin, {
      slug: groupSlug("noorg"),
      name: "x",
      organizationId: NON_EXISTENT_UUID,
    });
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.body.error).toBe("unknown_organization");
  });

  it("returns 403 for a role whose permissions the caller does not hold", async () => {
    const narrow = await getTestPrincipalToken({
      permissions: ["groups.write"],
    });
    const role = await roleGranting();
    const res = await adminApi("POST", "/groups", narrow, {
      slug: groupSlug("grant"),
      name: "x",
      roleIds: [role.id],
    });
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
  });
});

describe("GET /v1/admin/groups", () => {
  it("filters by organization, global and q, and pages with a cursor", async () => {
    const orgId = await newOrg();
    const marker = randomUUID().slice(0, 8);
    const a = track(
      await postGroup(admin, { organizationId: orgId, name: `alpha ${marker}` })
    );
    const b = track(
      await postGroup(admin, { organizationId: orgId, name: `beta ${marker}` })
    );
    const global = track(await postGroup(admin, { name: `gamma ${marker}` }));

    const inOrg = await adminApi(
      "GET",
      `/groups?organizationId=${orgId}`,
      admin
    );
    expect(inOrg.status).toBe(HTTP_STATUS.OK);
    expect(inOrg.body.data.map((g: ApiGroup) => g.id).sort()).toEqual(
      [a.id, b.id].sort()
    );

    const globals = await adminApi(
      "GET",
      `/groups?organizationId=global&q=${marker}`,
      admin
    );
    expect(globals.body.data.map((g: ApiGroup) => g.id)).toEqual([global.id]);

    const first = await adminApi(
      "GET",
      `/groups?organizationId=${orgId}&limit=1`,
      admin
    );
    expect(first.body.data).toHaveLength(1);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await adminApi(
      "GET",
      `/groups?organizationId=${orgId}&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      admin
    );
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    expect(second.body.nextCursor).toBeNull();
  });

  it("filters by archived state", async () => {
    const orgId = await newOrg();
    const live = track(await postGroup(admin, { organizationId: orgId }));
    const gone = track(await postGroup(admin, { organizationId: orgId }));
    await adminApi("POST", `/groups/${gone.id}/archive`, admin);

    const archived = await adminApi(
      "GET",
      `/groups?organizationId=${orgId}&archived=true`,
      admin
    );
    expect(archived.body.data.map((g: ApiGroup) => g.id)).toEqual([gone.id]);
    const unarchived = await adminApi(
      "GET",
      `/groups?organizationId=${orgId}&archived=false`,
      admin
    );
    expect(unarchived.body.data.map((g: ApiGroup) => g.id)).toEqual([live.id]);
  });

  it("lets an org admin without groups.read list only their organization's groups", async () => {
    const orgId = await newOrg();
    const group = track(await postGroup(admin, { organizationId: orgId }));
    const userId = randomUUID();
    const token = await getTestPrincipalToken({ userId, permissions: [] });
    await joinOrg(orgId, userId, "admin");

    const own = await adminApi("GET", `/groups?organizationId=${orgId}`, token);
    expect(own.status).toBe(HTTP_STATUS.OK);
    expect(own.body.data.map((g: ApiGroup) => g.id)).toEqual([group.id]);

    const all = await adminApi("GET", "/groups", token);
    expect(all.status).toBe(HTTP_STATUS.FORBIDDEN);
    const other = await adminApi(
      "GET",
      `/groups?organizationId=${await newOrg()}`,
      token
    );
    expect(other.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("rejects a cursor minted for another list", async () => {
    const orgId = await newOrg();
    track(await postGroup(admin, { organizationId: orgId }));
    track(await postGroup(admin, { organizationId: orgId }));
    const first = await adminApi(
      "GET",
      `/groups?organizationId=${orgId}&limit=1`,
      admin
    );
    const res = await adminApi(
      "GET",
      `/groups/${first.body.data[0].id}/members?cursor=${encodeURIComponent(first.body.nextCursor)}`,
      admin
    );
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.body.error).toBe("invalid_cursor");
  });
});
