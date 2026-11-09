// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../../../../../../utils/defaultOrganization.js";
import { createTestUser } from "../../../../../../support/auth/users.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import db from "../../../../../../../utils/db/index.js";
import { randomUUID } from "node:crypto";
import {
  HTTP_STATUS,
  NON_EXISTENT_UUID,
} from "../../../../../../support/auth/constants.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../../../../support/principals.js";
import {
  archiveGroup,
  createGroup,
  addMembers,
} from "../../../../../../../utils/groups.js";
import {
  adminApi,
  deleteGroups,
  groupSlug,
  joinOrg,
  PROVISIONING,
  type ApiGroup,
} from "../../../../../../support/groups.js";

const groupIds: string[] = [];
let reader: string;

/** A group, provisioned, with `userId` as a member; global unless `organizationId`. */
const groupWith = async (
  userId: string,
  organizationId: string | null = null
) => {
  const group = await db.$transaction(async (tx) => {
    const { group } = await createGroup(
      PROVISIONING,
      { organizationId, slug: groupSlug("user"), name: "Member of" },
      tx
    );
    await addMembers(PROVISIONING, group.id, [userId], tx);
    return group;
  });
  groupIds.push(group.id);
  return group;
};

beforeAll(async () => {
  await ensureDefaultOrganization();
  reader = await getTestPrincipalToken({ permissions: ["users.read"] });
});

afterAll(async () => {
  await deleteGroups(groupIds);
});

describe("GET /v1/admin/users/:id/groups", () => {
  it("lists the user's groups with member counts", async () => {
    const user = (await createTestUser()).id;
    const a = await groupWith(user);
    const b = await groupWith(user);

    const res = await adminApi("GET", `/users/${user}/groups`, reader);
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.data.map((g: ApiGroup) => g.id).sort()).toEqual(
      [a.id, b.id].sort()
    );
    expect(res.body.data[0]).toMatchObject({
      definitionSource: "provisioned",
      memberCount: 1,
    });
  });

  it("names each group's organization, null for a global group", async () => {
    const user = (await createTestUser()).id;
    const label = `user-groups-${randomUUID()}`;
    const orgId = await ensureTestOrganization(label);
    await joinOrg(orgId, user);
    const global = await groupWith(user);
    const inOrg = await groupWith(user, orgId);

    const res = await adminApi("GET", `/users/${user}/groups`, reader);
    expect(res.status).toBe(HTTP_STATUS.OK);
    const byId = new Map(res.body.data.map((g: ApiGroup) => [g.id, g]));
    expect(byId.get(global.id)).toMatchObject({ organization: null });
    expect(byId.get(inOrg.id)).toMatchObject({
      organizationId: orgId,
      organization: { id: orgId, name: `Test Org ${label}` },
    });
  });

  it("leaves archived groups out unless includeArchived=true", async () => {
    const user = (await createTestUser()).id;
    const group = await groupWith(user);
    await db.$transaction((tx) => archiveGroup(PROVISIONING, group.id, tx));

    const live = await adminApi("GET", `/users/${user}/groups`, reader);
    expect(live.body.data).toEqual([]);
    const all = await adminApi(
      "GET",
      `/users/${user}/groups?includeArchived=true`,
      reader
    );
    expect(all.body.data.map((g: ApiGroup) => g.id)).toEqual([group.id]);
  });

  it("returns 404 for a missing user", async () => {
    const res = await adminApi(
      "GET",
      `/users/${NON_EXISTENT_UUID}/groups`,
      reader
    );
    expect(res.status).toBe(HTTP_STATUS.NOT_FOUND);
  });
});
