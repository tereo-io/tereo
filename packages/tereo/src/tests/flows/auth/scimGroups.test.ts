// @module-tag int
// @module-tag auth
import { adminApi, joinOrg, roleGranting } from "../../support/groups.js";
import { oktaRemoveMemberPatch } from "../../fixtures/scim/okta.js";
import { getTestPrincipalToken } from "../../support/principals.js";
import { createTestUser } from "../../support/auth/users.js";
import { BASE_URL } from "../../support/auth/constants.js";
import { managedUser } from "../../support/scimGroups.js";
import { fetchJson } from "../../support/http.js";
import { tag } from "../../support/scimUsers.js";
import { describe, expect, it } from "vitest";
import {
  createScimConnection,
  pushGroup,
  scimFetch,
} from "../../support/scim.js";

interface Userinfo {
  groups?: { id: string }[];
}

describe("SCIM groups", () => {
  it("a directory group grants and withdraws a role", async () => {
    const globalAdmin = await getTestPrincipalToken({ permissions: ["admin"] });
    const c = await createScimConnection();
    const member = await managedUser(c);
    const memberToken = await getTestPrincipalToken({
      userId: member.id,
      organizationId: c.organizationId,
      permissions: [],
    });
    const gated = (token: string) =>
      fetchJson("GET", `${BASE_URL}/v1/webhooks/event-types`, token);
    const userinfo = async () =>
      (await fetchJson("GET", `${BASE_URL}/oauth/userinfo`, memberToken))
        .body as Userinfo;

    const target = await fetchJson(
      "PUT",
      `${BASE_URL}/v1/admin/identity-providers/${c.providerId}/scim`,
      globalAdmin,
      {
        isActive: true,
        groupsTarget: {
          kind: "organization",
          organizationId: c.organizationId,
        },
      }
    );
    expect(target.status).toBe(200);

    const pushed = await pushGroup(c.token, {
      displayName: `Directory ${tag()}`,
      externalId: `ext-${tag()}`,
      members: [{ value: member.id }],
    });
    expect(pushed.status).toBe(201);
    const groupId = pushed.body.id as string;

    expect((await gated(memberToken)).status).toBe(403);

    const role = await roleGranting(["webhooks.event-types.read"]);
    const orgAdmin = await createTestUser();
    await joinOrg(c.organizationId, orgAdmin.id, "admin");
    const orgAdminToken = await getTestPrincipalToken({
      userId: orgAdmin.id,
      organizationId: c.organizationId,
      permissions: ["webhooks.event-types.read"],
    });
    const attached = await adminApi(
      "PUT",
      `/groups/${groupId}/roles`,
      orgAdminToken,
      { roleIds: [role.id] }
    );
    expect(attached.status).toBe(200);

    expect((await gated(memberToken)).status).toBe(200);
    expect((await userinfo()).groups?.map((g) => g.id)).toEqual([groupId]);

    const removed = await scimFetch(
      c.token,
      "PATCH",
      `/scim/v2/Groups/${groupId}`,
      {
        ...oktaRemoveMemberPatch,
        Operations: oktaRemoveMemberPatch.Operations.map((op) => ({
          ...op,
          path: op.path.replace(/"[^"]+"/, `"${member.id}"`),
        })),
      }
    );
    expect(removed.status).toBe(200);
    expect((await gated(memberToken)).status).toBe(403);
    expect((await userinfo()).groups).toEqual([]);

    const deleted = await scimFetch(
      c.token,
      "DELETE",
      `/scim/v2/Groups/${groupId}`
    );
    expect(deleted.status).toBe(204);
    const shown = await adminApi("GET", `/groups/${groupId}`, globalAdmin);
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({
      definitionSource: "local",
      membershipSource: "local",
      managedBy: null,
    });
    expect(shown.body.archivedAt).not.toBeNull();
    const gone = await scimFetch(c.token, "GET", `/scim/v2/Groups/${groupId}`);
    expect(gone.status).toBe(404);
  });
});
