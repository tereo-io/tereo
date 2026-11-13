// @module-tag int
// @module-tag auth
import { tag } from "../../../../support/scimUsers.js";
import { describe, expect, it } from "vitest";
import {
  createScimConnection,
  pushGroup,
  scimFetch,
  setGroupsTarget,
} from "../../../../support/scim.js";

const orgConnection = async () => {
  const c = await createScimConnection();
  await setGroupsTarget(c.connectionId, {
    kind: "organization",
    organizationId: c.organizationId,
  });
  return c;
};

const list = (token: string, query = "") =>
  scimFetch(token, "GET", `/scim/v2/Groups${query}`);
const filtered = (token: string, filter: string) =>
  list(token, `?filter=${encodeURIComponent(filter)}`);

describe("GET /scim/v2/Groups", () => {
  it("lists only the connection's own groups, without members", async () => {
    const a = await orgConnection();
    const b = await orgConnection();
    const mine = await pushGroup(a.token, { displayName: `Mine ${tag()}` });
    await pushGroup(b.token, { displayName: `Theirs ${tag()}` });
    const { status, body } = await list(a.token);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      totalResults: 1,
      startIndex: 1,
      itemsPerPage: 1,
    });
    expect(body.Resources[0].id).toBe(mine.body.id);
    expect(body.Resources[0]).not.toHaveProperty("members");
  });

  it("matches displayName case-insensitively and returns same-named groups", async () => {
    const c = await orgConnection();
    const name = `Engineering ${tag()}`;
    await pushGroup(c.token, { displayName: name });
    await pushGroup(c.token, { displayName: name });
    await pushGroup(c.token, { displayName: `Other ${tag()}` });
    const { body } = await filtered(
      c.token,
      `displayName eq "${name.toLowerCase()}"`
    );
    expect(body.totalResults).toBe(2);
  });

  it("matches externalId exactly", async () => {
    const c = await orgConnection();
    await pushGroup(c.token, { displayName: `A ${tag()}`, externalId: "Ext1" });
    expect(
      (await filtered(c.token, 'externalId eq "Ext1"')).body.totalResults
    ).toBe(1);
    expect(
      (await filtered(c.token, 'externalId eq "ext1"')).body.totalResults
    ).toBe(0);
  });

  it("paginates", async () => {
    const c = await orgConnection();
    for (let i = 0; i < 3; i++) {
      await pushGroup(c.token, { displayName: `P${i} ${tag()}` });
    }
    const { body } = await list(c.token, "?startIndex=2&count=1");
    expect(body).toMatchObject({
      totalResults: 3,
      startIndex: 2,
      itemsPerPage: 1,
    });
  });
});
