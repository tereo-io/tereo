// @module-tag int
// @module-tag auth
import { createScimConnection, scimFetch } from "../../support/scim.js";
import { getTestPrincipalToken } from "../../support/principals.js";
import { oktaCreateUser } from "../../fixtures/scim/okta.js";
import { BASE_URL } from "../../support/auth/constants.js";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { fetchJson } from "../../support/http.js";
import { tag } from "../../support/scimUsers.js";
import {
  localGroupWith,
  managedUser,
  memberIds,
  orgConnection,
  pushedGroup,
  skippedIds,
} from "../../support/scimGroups.js";

const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

let writer: string;
let globalAdmin: string;

beforeAll(async () => {
  writer = await getTestPrincipalToken({
    permissions: ["users.read", "users.write"],
  });
  globalAdmin = await getTestPrincipalToken({ permissions: ["admin"] });
});

const createBody = (email: string, givenName = "Idp") => ({
  ...oktaCreateUser,
  userName: email,
  name: { givenName, familyName: "Person" },
  emails: [{ primary: true, type: "work", value: email }],
  externalId: `ext-${tag()}`,
});

const userState = (id: string) =>
  prisma.user.findUniqueOrThrow({
    where: { id },
    include: { scimLink: true },
  });

describe("SCIM unlink and release", () => {
  it("keeps an unlinked user out of the IdP's reach until an admin releases them", async () => {
    const c = await createScimConnection();
    const email = `unl-${tag()}@${c.domain}`;
    const created = await scimFetch(
      c.token,
      "POST",
      "/scim/v2/Users",
      createBody(email)
    );
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const path = `/scim/v2/Users/${id}`;

    const deactivated = await scimFetch(c.token, "PATCH", path, {
      schemas: [PATCH_OP],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(deactivated.status).toBe(200);
    expect((await userState(id)).isActive).toBe(false);

    const unlinked = await fetchJson(
      "DELETE",
      `${BASE_URL}/v1/admin/users/${id}/scim`,
      writer
    );
    expect(unlinked.status).toBe(204);
    const local = await fetchJson(
      "PATCH",
      `${BASE_URL}/v1/admin/users/${id}`,
      writer,
      { name: "Local Name", isActive: true }
    );
    expect(local.status).toBe(200);
    const before = await userState(id);
    expect(before).toMatchObject({ name: "Local Name", isActive: true });

    const off = await scimFetch(c.token, "PATCH", path, {
      schemas: [PATCH_OP],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(off.status).toBe(404);
    const renamed = await scimFetch(c.token, "PUT", path, {
      ...createBody(email, "Renamed"),
      active: true,
    });
    expect(renamed.status).toBe(404);
    expect(await userState(id)).toEqual(before);

    const again = await scimFetch(
      c.token,
      "POST",
      "/scim/v2/Users",
      createBody(email)
    );
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ scimType: "uniqueness" });
    expect(await userState(id)).toEqual(before);

    const released = await fetchJson(
      "PUT",
      `${BASE_URL}/v1/admin/users/${id}/scim/release`,
      globalAdmin
    );
    expect(released.status).toBe(204);

    const adopted = await scimFetch(
      c.token,
      "POST",
      "/scim/v2/Users",
      createBody(email, "Adopted")
    );
    expect(adopted.status).toBe(201);
    expect(adopted.body).toMatchObject({ id, active: true });
    const after = await userState(id);
    expect(after).toMatchObject({ firstName: "Adopted", isActive: true });
    expect(after.scimLink).toMatchObject({
      connectionId: c.connectionId,
      deletedAt: null,
      unlinkedAt: null,
      idpActive: true,
      adminHold: false,
    });
  });

  it("takes an unlinked user out of the connection's groups and keeps their local ones", async () => {
    const c = await orgConnection();
    const user = await managedUser(c);
    const other = await managedUser(c);
    const first = await pushedGroup(c, [user.id, other.id]);
    const second = await pushedGroup(c, [user.id]);
    const third = await pushedGroup(c, [other.id], [user.id]);
    const local = await localGroupWith(c, user.id);

    const unlinked = await fetchJson(
      "DELETE",
      `${BASE_URL}/v1/admin/users/${user.id}/scim`,
      writer
    );
    expect(unlinked.status).toBe(204);

    expect(await memberIds(first.id)).toEqual([other.id]);
    expect(await memberIds(second.id)).toEqual([]);
    expect(await skippedIds(third.id)).toEqual([]);
    expect(await memberIds(local.id)).toEqual([user.id]);
    const entries = await prisma.auditLogEntry.findMany({
      where: {
        entityType: "Group",
        entityId: { in: [first.id, second.id] },
        metadata: { path: ["action"], equals: "members_removed" },
      },
    });
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.metadata).toMatchObject({ reason: "scim_user_left" });
    }
  });
});
