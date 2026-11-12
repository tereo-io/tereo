// @module-tag int
// @module-tag auth
import { ensureDefaultOrganization } from "../../../../../../../../utils/defaultOrganization.js";
import { getTestPrincipalToken } from "../../../../../../../support/principals.js";
import { NON_EXISTENT_UUID } from "../../../../../../../support/auth/constants.js";
import { createTestUser } from "../../../../../../../support/auth/users.js";
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  globalConnection,
  orgConnection,
  pushedGroup,
} from "../../../../../../../support/scimGroups.js";
import {
  adminApi,
  joinOrg,
  postGroup,
} from "../../../../../../../support/groups.js";

let admin: string;

beforeAll(async () => {
  await ensureDefaultOrganization();
  admin = await getTestPrincipalToken({ permissions: ["groups.admin"] });
});

const orgAdminToken = async (organizationId: string) => {
  const user = await createTestUser();
  await joinOrg(organizationId, user.id, "admin");
  return await getTestPrincipalToken({ userId: user.id, permissions: [] });
};

const listPath = (id: string, query = "") =>
  `/groups/${id}/scim/skipped-members${query}`;

describe("GET /v1/admin/groups/:id/scim/skipped-members", () => {
  it("lists the recorded user with the reason", async () => {
    const c = await orgConnection();
    const user = await createTestUser();
    const { id } = await pushedGroup(c, [], [user.id]);

    const res = await adminApi("GET", listPath(id), admin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hasMore: false, nextCursor: null });
    expect(res.body.data).toEqual([
      {
        userId: user.id,
        email: user.email,
        name: expect.anything(),
        reason: "not_org_member",
        skippedAt: expect.any(String),
      },
    ]);
  });

  it("paginates with an opaque cursor", async () => {
    const c = await orgConnection();
    const users = [
      await createTestUser(),
      await createTestUser(),
      await createTestUser(),
    ];
    const { id } = await pushedGroup(
      c,
      [],
      users.map((u) => u.id)
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await adminApi("GET", listPath(id, q), admin);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.map((m: { userId: string }) => m.userId));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(2);
    expect(seen.sort()).toEqual(users.map((u) => u.id).sort());
  });

  it("returns 400 for a cursor that is not an id", async () => {
    const c = await orgConnection();
    const { id } = await pushedGroup(c, []);
    const res = await adminApi("GET", listPath(id, "?cursor=abc"), admin);
    expect(res.status).toBe(400);
  });

  it("returns 404 for a local group", async () => {
    const local = await postGroup(admin);
    const res = await adminApi("GET", listPath(local.id), admin);
    expect(res.status).toBe(404);
  });

  it("returns 404 for a missing group to a groups.read holder", async () => {
    const res = await adminApi("GET", listPath(NON_EXISTENT_UUID), admin);
    expect(res.status).toBe(404);
  });

  it("returns 403 to a caller who may not read the group", async () => {
    const c = await orgConnection();
    const { id } = await pushedGroup(c, []);
    const stranger = await getTestPrincipalToken({ permissions: [] });
    const res = await adminApi("GET", listPath(id), stranger);
    expect(res.status).toBe(403);
  });

  it("continues past the row the cursor names when it was deleted", async () => {
    const c = await orgConnection();
    const users = [
      await createTestUser(),
      await createTestUser(),
      await createTestUser(),
    ];
    const { id } = await pushedGroup(
      c,
      [],
      users.map((u) => u.id)
    );
    const first = await adminApi("GET", listPath(id, "?limit=1"), admin);
    expect(first.body.hasMore).toBe(true);
    await prisma.scimGroupSkippedMember.delete({
      where: { id: first.body.nextCursor },
    });

    const second = await adminApi(
      "GET",
      listPath(id, `?limit=5&cursor=${first.body.nextCursor}`),
      admin
    );
    expect(second.status).toBe(200);
    expect(second.body.data).toHaveLength(2);
  });

  it("gives another organization's admin the uniform 403 on an organization's pushed group", async () => {
    const c = await orgConnection();
    const { id } = await pushedGroup(c, []);
    const other = await orgConnection();
    const res = await adminApi(
      "GET",
      listPath(id),
      await orgAdminToken(other.organizationId)
    );
    expect(res.status).toBe(403);
    const sibling = await adminApi(
      "GET",
      `/groups/${id}/members`,
      await orgAdminToken(other.organizationId)
    );
    expect(res.body).toEqual(sibling.body);
  });

  it("gives an organization admin the uniform 403 on a global pushed group", async () => {
    const g = await globalConnection();
    const { id } = await pushedGroup(g, []);
    const c = await orgConnection();
    const token = await orgAdminToken(c.organizationId);
    const res = await adminApi("GET", listPath(id), token);
    expect(res.status).toBe(403);
    const sibling = await adminApi("GET", `/groups/${id}/members`, token);
    expect(res.body).toEqual(sibling.body);
  });

  it("lets an organization admin read their organization's group", async () => {
    const c = await orgConnection();
    const { id } = await pushedGroup(c, []);
    const orgAdmin = await createTestUser();
    await joinOrg(c.organizationId, orgAdmin.id, "admin");
    const token = await getTestPrincipalToken({
      userId: orgAdmin.id,
      permissions: [],
    });
    const res = await adminApi("GET", listPath(id), token);
    expect(res.status).toBe(200);
  });
});
