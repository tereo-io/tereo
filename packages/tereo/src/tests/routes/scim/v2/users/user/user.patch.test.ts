// @module-tag int
// @module-tag auth
import { makeUser, manage, tag } from "../../../../../support/scimUsers.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { describe, expect, it } from "vitest";
import {
  entraAttributePatch,
  entraDeactivatePatch,
} from "../../../../../fixtures/scim/entra.js";
import {
  oktaAttributePatch,
  oktaDeactivatePatch,
} from "../../../../../fixtures/scim/okta.js";
import {
  createScimConnection,
  scimFetch,
} from "../../../../../support/scim.js";

const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

const patch = (token: string, id: string, body: unknown) =>
  scimFetch(token, "PATCH", `/scim/v2/Users/${id}`, body);

const ops = (...Operations: Array<Record<string, unknown>>) => ({
  schemas: [PATCH_OP],
  Operations,
});

const userEntries = (userId: string) =>
  prisma.auditLogEntry.findMany({
    where: { entityType: "User", entityId: userId },
  });

const row = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } });

const managedUser = async (c: { connectionId: string; domain: string }) => {
  const user = await makeUser(`m-${tag()}@${c.domain}`);
  await prisma.user.update({
    where: { id: user.id },
    data: { firstName: "Jane", lastName: "Doe" },
  });
  await manage(c.connectionId, user.id, user.email);
  return user;
};

describe("PATCH /scim/v2/Users/:id", () => {
  it("changes only what it names", async () => {
    const c = await createScimConnection();
    const user = await managedUser(c);
    const { status, body } = await patch(
      c.token,
      user.id,
      ops({ op: "replace", path: "name.givenName", value: "Janet" })
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      name: { givenName: "Janet", familyName: "Doe" },
      displayName: "Test Person",
    });
    expect(await row(user.id)).toMatchObject({
      firstName: "Janet",
      lastName: "Doe",
      name: "Test Person",
    });
  });

  it("stores a whitespace-only value as cleared, as PUT does", async () => {
    const c = await createScimConnection();
    const user = await managedUser(c);
    const { status } = await patch(
      c.token,
      user.id,
      ops({ op: "replace", path: "name.familyName", value: "   " })
    );
    expect(status).toBe(200);
    expect((await row(user.id)).lastName).toBeNull();
  });

  it("adopts an unmanaged visible user", async () => {
    const c = await createScimConnection();
    const user = await makeUser(`free-${tag()}@${c.domain}`);
    const { status, body } = await patch(
      c.token,
      user.id,
      ops({ op: "replace", path: "name.givenName", value: "Ann" })
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ userName: user.email });
    const link = await prisma.scimUser.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(link).toMatchObject({
      connectionId: c.connectionId,
      userName: user.email,
      externalId: null,
    });
    expect((await row(user.id)).firstName).toBe("Ann");
    const entries = await userEntries(user.id);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "scim_adopted" }),
      ])
    );
  });

  it("applies the Okta attribute fixture", async () => {
    const c = await createScimConnection();
    const user = await managedUser(c);
    const { status, body } = await patch(c.token, user.id, oktaAttributePatch);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      displayName: "Jane Q. Doe",
      name: { givenName: "Janet", familyName: "Doe" },
    });
  });

  it("applies the Entra attribute fixture", async () => {
    const c = await createScimConnection();
    const user = await managedUser(c);
    const email = `janet.roe-${tag()}@${c.domain}`;
    const fixture = {
      ...entraAttributePatch,
      Operations: entraAttributePatch.Operations.map((o) =>
        o.path.startsWith("emails") ? { ...o, value: email } : o
      ),
    };
    const { status, body } = await patch(c.token, user.id, fixture);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      name: { givenName: "Janet", familyName: "Roe" },
      emails: [{ value: email, primary: true }],
      externalId: "new-external-id",
    });
    expect((await row(user.id)).email).toBe(email);
  });

  // Acting on active arrives with deactivation; until then the IdP's view is
  // recorded on the link and the user is left as is.
  it.each([
    ["Okta", oktaDeactivatePatch],
    ["Entra", entraDeactivatePatch],
  ])("accepts the %s deactivate fixture", async (_, fixture) => {
    const c = await createScimConnection();
    const user = await managedUser(c);
    const { status } = await patch(c.token, user.id, fixture);
    expect(status).toBe(200);
    const link = await prisma.scimUser.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(link.idpActive).toBe(false);
  });

  it("applies nothing when a later operation names an outside address", async () => {
    const c = await createScimConnection();
    const user = await managedUser(c);
    const { status, body } = await patch(
      c.token,
      user.id,
      ops(
        { op: "replace", path: "name.givenName", value: "Changed" },
        { op: "replace", path: "emails", value: [{ value: "x@outside.test" }] }
      )
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ scimType: "invalidValue" });
    expect((await row(user.id)).firstName).toBe("Jane");
    expect(await userEntries(user.id)).toHaveLength(0);
  });

  it("leaves an unmanaged user unadopted when a later operation is refused", async () => {
    const c = await createScimConnection();
    const user = await makeUser(`free-${tag()}@${c.domain}`);
    const { status } = await patch(
      c.token,
      user.id,
      ops(
        { op: "replace", path: "name.givenName", value: "Changed" },
        { op: "replace", path: "emails", value: [{ value: "x@outside.test" }] }
      )
    );
    expect(status).toBe(400);
    expect(await prisma.scimUser.count({ where: { userId: user.id } })).toBe(0);
    expect(await userEntries(user.id)).toHaveLength(0);
  });

  it("answers 409 uniqueness for an address another user has", async () => {
    const c = await createScimConnection();
    const user = await managedUser(c);
    const other = await makeUser(`taken-${tag()}@${c.domain}`);
    const { status, body } = await patch(
      c.token,
      user.id,
      ops({ op: "replace", path: "emails", value: other.email })
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ scimType: "uniqueness" });
  });

  it("writes no audit entry when nothing changes", async () => {
    const c = await createScimConnection();
    const user = await managedUser(c);
    const { status } = await patch(
      c.token,
      user.id,
      ops(
        { op: "replace", path: "name.givenName", value: "Jane" },
        { op: "replace", path: "emails", value: user.email.toUpperCase() }
      )
    );
    expect(status).toBe(200);
    expect(await userEntries(user.id)).toHaveLength(0);
  });

  it("changes only the link for a new userName", async () => {
    const c = await createScimConnection();
    const user = await managedUser(c);
    const before = await row(user.id);
    const { status, body } = await patch(
      c.token,
      user.id,
      ops({ op: "replace", path: "userName", value: "jdoe" })
    );
    expect(status).toBe(200);
    expect(body.userName).toBe("jdoe");
    expect(await row(user.id)).toEqual(before);
    expect(await userEntries(user.id)).toHaveLength(0);
  });
});
