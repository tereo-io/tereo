// @module-tag int
// @module-tag auth
import { makeUser, manage, tag } from "../../../../../support/scimUsers.js";
import { SYSTEM_USER_ID } from "../../../../../../definitions/index.js";
import { describe, expect, it } from "vitest";
import {
  createScimConnection,
  scimFetch,
} from "../../../../../support/scim.js";

const get = (token: string, id: string) =>
  scimFetch(token, "GET", `/scim/v2/Users/${id}`);

const expectNotFound = (r: {
  status: number;
  body: Record<string, unknown>;
}) => {
  expect(r.status).toBe(404);
  expect(r.body).toMatchObject({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    status: "404",
  });
};

describe("GET /scim/v2/Users/:id", () => {
  it("returns a managed user", async () => {
    const c = await createScimConnection();
    const user = await makeUser(`m-${tag()}@${c.domain}`);
    await manage(c.connectionId, user.id, "Alias", { externalId: "e1" });
    const { status, body } = await get(c.token, user.id);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      id: user.id,
      userName: "Alias",
      externalId: "e1",
      active: true,
      emails: [{ value: user.email, primary: true }],
    });
    expect(body.meta.location).toMatch(
      new RegExp(`/scim/v2/Users/${user.id}$`)
    );
  });

  it("returns an unmanaged in-domain human by its email", async () => {
    const c = await createScimConnection();
    const user = await makeUser(`free-${tag()}@${c.domain}`);
    const { status, body } = await get(c.token, user.id);
    expect(status).toBe(200);
    expect(body.userName).toBe(user.email);
  });

  it("accepts an upper-case id", async () => {
    const c = await createScimConnection();
    const user = await makeUser(`free-${tag()}@${c.domain}`);
    expect((await get(c.token, user.id.toUpperCase())).status).toBe(200);
  });

  it("answers 404 for every invisible user and a malformed id", async () => {
    const c = await createScimConnection();
    const other = await createScimConnection();
    const stamp = tag();
    const guest = await makeUser(`g-${stamp}@${c.domain}`, {
      userType: "guest",
    });
    const service = await makeUser(`s-${stamp}@${c.domain}`, {
      userType: "service_account",
    });
    const elsewhere = await makeUser(`o-${stamp}@out-${stamp}.test`);
    const theirs = await makeUser(`t-${stamp}@${c.domain}`);
    await manage(other.connectionId, theirs.id, theirs.email);
    const deleted = await makeUser(`d-${stamp}@${c.domain}`);
    await manage(c.connectionId, deleted.id, deleted.email, {
      deletedAt: new Date(),
    });
    const ids = [
      guest.id,
      service.id,
      elsewhere.id,
      theirs.id,
      deleted.id,
      SYSTEM_USER_ID,
      "00000000-0000-7000-8000-00000000dead",
      "not-a-uuid",
    ];
    for (const id of ids) expectNotFound(await get(c.token, id));
  });
});
