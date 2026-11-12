// @module-tag int
// @module-tag auth
import { makeUser, manage, tag } from "../../../../../support/scimUsers.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { joinOrg } from "../../../../../support/groups.js";
import { describe, expect, it } from "vitest";
import {
  createScimConnection,
  pushGroup,
  scimFetch,
  setGroupsTarget,
} from "../../../../../support/scim.js";

const orgConnection = async () => {
  const c = await createScimConnection();
  await setGroupsTarget(c.connectionId, {
    kind: "organization",
    organizationId: c.organizationId,
  });
  return c;
};

const get = (token: string, id: string, query = "") =>
  scimFetch(token, "GET", `/scim/v2/Groups/${id}${query}`);

describe("GET /scim/v2/Groups/:id", () => {
  it("returns an own group with its members", async () => {
    const c = await orgConnection();
    const user = await makeUser(`m-${tag()}@${c.domain}`);
    await joinOrg(c.organizationId, user.id);
    await manage(c.connectionId, user.id, user.email);
    const pushed = await pushGroup(c.token, {
      displayName: `G ${tag()}`,
      members: [{ value: user.id }],
    });
    const { status, body } = await get(c.token, pushed.body.id);
    expect(status).toBe(200);
    expect(body.members).toEqual([
      expect.objectContaining({ value: user.id, display: "Test Person" }),
    ]);
  });

  it("omits members for excludedAttributes=members", async () => {
    const c = await orgConnection();
    const user = await makeUser(`m-${tag()}@${c.domain}`);
    await joinOrg(c.organizationId, user.id);
    await manage(c.connectionId, user.id, user.email);
    const pushed = await pushGroup(c.token, {
      displayName: `G ${tag()}`,
      members: [{ value: user.id }],
    });
    const { status, body } = await get(
      c.token,
      pushed.body.id,
      "?excludedAttributes=id,Members"
    );
    expect(status).toBe(200);
    expect(body).not.toHaveProperty("members");
  });

  it("is 404 for another connection's group, a local group and a non-uuid", async () => {
    const a = await orgConnection();
    const b = await orgConnection();
    const theirs = await pushGroup(b.token, { displayName: `T ${tag()}` });
    const local = await prisma.group.create({
      data: {
        organizationId: a.organizationId,
        slug: `local-${tag()}`,
        name: "Local",
        definitionSource: "local",
        createdBy: (await makeUser(`l-${tag()}@${a.domain}`)).id,
      },
    });
    expect((await get(a.token, theirs.body.id)).status).toBe(404);
    expect((await get(a.token, local.id)).status).toBe(404);
    expect((await get(a.token, "not-a-uuid")).status).toBe(404);
  });

  it("still returns an admin-archived linked group", async () => {
    const c = await orgConnection();
    const pushed = await pushGroup(c.token, { displayName: `A ${tag()}` });
    await prisma.group.update({
      where: { id: pushed.body.id },
      data: { archivedAt: new Date() },
    });
    expect((await get(c.token, pushed.body.id)).status).toBe(200);
  });
});
