// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../../../../../utils/defaultOrganization.js";
import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createGroup } from "../../../../../../utils/groups.js";
import db from "../../../../../../utils/db/index.js";
import {
  HTTP_STATUS,
  NON_EXISTENT_UUID,
} from "../../../../../support/auth/constants.js";
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
  admin = await getTestPrincipalToken({ permissions: ["groups.admin"] });
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
