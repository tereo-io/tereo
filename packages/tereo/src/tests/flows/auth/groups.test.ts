// @module-tag int
// @module-tag auth
import { BASE_URL, HTTP_STATUS } from "../../support/auth/constants.js";
import { getTestPrincipalToken } from "../../support/principals.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestUser } from "../../support/auth/users.js";
import { fetchJson } from "../../support/http.js";
import {
  adminApi,
  deleteGroups,
  postGroup,
  roleGranting,
} from "../../support/groups.js";

interface Userinfo {
  roles?: string[];
  groups?: { id: string; slug: string }[];
}

describe("group membership grants permissions", () => {
  const groupIds: string[] = [];
  let adminToken: string;

  beforeAll(async () => {
    adminToken = await getTestPrincipalToken({ permissions: ["admin"] });
  });
  afterAll(() => deleteGroups(groupIds));

  const userinfo = async (token: string) =>
    (await fetchJson("GET", `${BASE_URL}/oauth/userinfo`, token))
      .body as Userinfo;
  const gated = (token: string) =>
    fetchJson("GET", `${BASE_URL}/v1/webhooks/event-types`, token);

  it("opens a gated route and shows in userinfo while the user is a member", async () => {
    const role = await roleGranting(["webhooks.event-types.read"]);
    const group = await postGroup(adminToken, { roleIds: [role.id] });
    groupIds.push(group.id);
    const user = await createTestUser();
    const token = await getTestPrincipalToken({
      userId: user.id,
      permissions: [],
    });

    expect((await gated(token)).status).toBe(HTTP_STATUS.FORBIDDEN);

    const added = await adminApi(
      "POST",
      `/groups/${group.id}/members`,
      adminToken,
      {
        userIds: [user.id],
      }
    );
    expect(added.status).toBe(HTTP_STATUS.OK);
    expect((await gated(token)).status).toBe(HTTP_STATUS.OK);
    const info = await userinfo(token);
    expect(info.groups?.map((g) => g.id)).toEqual([group.id]);

    const roles = await adminApi("GET", `/users/${user.id}/roles`, adminToken);
    expect(roles.body.roles).toEqual([]);
    expect(roles.body.groupRoles.map((r: { id: string }) => r.id)).toEqual([
      role.id,
    ]);

    const removed = await adminApi(
      "DELETE",
      `/groups/${group.id}/members/${user.id}`,
      adminToken
    );
    expect(removed.status).toBeLessThan(300);
    expect((await gated(token)).status).toBe(HTTP_STATUS.FORBIDDEN);
    expect((await userinfo(token)).groups).toEqual([]);
  });
});
