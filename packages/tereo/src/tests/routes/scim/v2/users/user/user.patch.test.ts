// @module-tag int
// @module-tag auth
import { createTestClient } from "../../../../../support/auth/clients.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  REDIRECT_URI,
  sessionLifecycleHelpers,
} from "../../../../../support/auth/sessionLifecycle.js";
import {
  entraAttributePatch,
  entraDeactivatePatch,
} from "../../../../../fixtures/scim/entra.js";
import {
  oktaAttributePatch,
  oktaDeactivatePatch,
} from "../../../../../fixtures/scim/okta.js";
import {
  activeState,
  makeUser,
  manage,
  managedWith,
  signedInManagedUser,
  tag,
} from "../../../../../support/scimUsers.js";
import {
  createScimConnection,
  scimFetch,
} from "../../../../../support/scim.js";

const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

let client: Awaited<ReturnType<typeof createTestClient>>;
const { login, refresh } = sessionLifecycleHelpers(() => client);

beforeAll(async () => {
  client = await createTestClient({ redirectUris: [REDIRECT_URI] });
});

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

  it.each([
    ["Okta", oktaDeactivatePatch],
    ["Entra", entraDeactivatePatch],
  ])(
    "deactivates by the %s fixture; a refresh token issued before is refused",
    async (_, fixture) => {
      const c = await createScimConnection();
      const { user, tokens } = await signedInManagedUser(c, login);
      const { status, body } = await patch(c.token, user.id, fixture);
      expect(status).toBe(200);
      expect(body.active).toBe(false);
      expect(await activeState(user.id)).toEqual({
        isActive: false,
        idpActive: false,
        adminHold: false,
      });
      expect((await refresh(tokens.refresh_token)).status).toBe(400);
    }
  );

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

describe("PATCH /scim/v2/Users/:id on a user the connection may not write", () => {
  it.each([
    ["another connection's managed user", "other"],
    ["a user whose link is deleted", "deleted"],
    ["a user an admin unlinked", "unlinked"],
  ] as const)("answers 404 for %s, changing nothing", async (_, kind) => {
    const c = await createScimConnection();
    const other = await createScimConnection();
    const user = await makeUser(`n-${tag()}@${c.domain}`);
    await manage(
      kind === "other" ? other.connectionId : c.connectionId,
      user.id,
      user.email,
      {
        ...(kind === "deleted" && { deletedAt: new Date() }),
        ...(kind === "unlinked" && { unlinkedAt: new Date() }),
      }
    );
    const withLink = () =>
      prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        include: { scimLink: true },
      });
    const before = await withLink();
    const r = await patch(
      c.token,
      user.id,
      ops(
        { op: "replace", path: "active", value: false },
        { op: "replace", path: "displayName", value: "Changed" }
      )
    );
    expect(r.status).toBe(404);
    expect(await withLink()).toEqual(before);
  });
});

describe("PATCH /scim/v2/Users/:id on a managed user whose domain left the provider", () => {
  it("still renames and deactivates them, and refuses an email change with 400 invalidValue", async () => {
    const c = await createScimConnection({
      domains: [`left-${tag()}.test`, `kept-${tag()}.test`],
    });
    const user = await managedWith(c);
    await prisma.identityProviderDomain.delete({ where: { domain: c.domain } });

    const renamed = await patch(
      c.token,
      user.id,
      ops({ op: "replace", path: "name.givenName", value: "Renamed" })
    );
    expect(renamed.status).toBe(200);
    expect((await row(user.id)).firstName).toBe("Renamed");

    const moved = await patch(
      c.token,
      user.id,
      ops({
        op: "replace",
        path: "emails",
        value: [{ value: `moved-${tag()}@${c.domain}`, primary: true }],
      })
    );
    expect(moved.status).toBe(400);
    expect(moved.body).toMatchObject({ scimType: "invalidValue" });
    expect((await row(user.id)).email).toBe(user.email);

    const off = await patch(
      c.token,
      user.id,
      ops({ op: "replace", path: "active", value: false })
    );
    expect(off.status).toBe(200);
    expect(await activeState(user.id)).toEqual({
      isActive: false,
      idpActive: false,
      adminHold: false,
    });
  });
});

describe("PATCH /scim/v2/Users/:id active", () => {
  const setActive = (token: string, id: string, active: boolean) =>
    patch(token, id, ops({ op: "replace", path: "active", value: active }));

  it("deactivates with one User entry carrying the connection", async () => {
    const c = await createScimConnection();
    const user = await managedWith(c);
    expect((await setActive(c.token, user.id, false)).status).toBe(200);
    const entries = await userEntries(user.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "UPDATE",
      changes: { isActive: { old: true, new: false } },
      metadata: { scimConnectionId: c.connectionId },
    });
  });

  it("deactivates when Entra also sends a home email outside the domains", async () => {
    const c = await createScimConnection();
    const user = await managedWith(c);
    const { status, body } = await patch(
      c.token,
      user.id,
      ops(
        { op: "Replace", path: "active", value: "False" },
        {
          op: "Add",
          path: 'emails[type eq "home"].value',
          value: `home-${tag()}@personal.test`,
        }
      )
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ active: false });
    expect(await activeState(user.id)).toEqual({
      isActive: false,
      idpActive: false,
      adminHold: false,
    });
    expect((await row(user.id)).email).toBe(user.email);
  });

  it("applies the profile in the deactivation's entry", async () => {
    const c = await createScimConnection();
    const user = await managedWith(c);
    const { status } = await patch(
      c.token,
      user.id,
      ops(
        { op: "replace", path: "name.givenName", value: "Gone" },
        { op: "replace", path: "active", value: false }
      )
    );
    expect(status).toBe(200);
    const entries = await userEntries(user.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].changes).toMatchObject({
      isActive: { old: true, new: false },
    });
    expect((await row(user.id)).firstName).toBe("Gone");
  });

  it("active:true reactivates", async () => {
    const c = await createScimConnection();
    const user = await managedWith(c, { idpActive: false });
    const { status, body } = await setActive(c.token, user.id, true);
    expect(status).toBe(200);
    expect(body.active).toBe(true);
    expect(await activeState(user.id)).toEqual({
      isActive: true,
      idpActive: true,
      adminHold: false,
    });
    const entries = await userEntries(user.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].changes).toMatchObject({
      isActive: { old: false, new: true },
    });
  });

  it("active:true under an admin hold answers active:false and records idpActive", async () => {
    const c = await createScimConnection();
    const user = await managedWith(c, { idpActive: false, adminHold: true });
    const { status, body } = await setActive(c.token, user.id, true);
    expect(status).toBe(200);
    expect(body.active).toBe(false);
    expect(await activeState(user.id)).toEqual({
      isActive: false,
      idpActive: true,
      adminHold: true,
    });
    expect(await userEntries(user.id)).toHaveLength(0);
  });

  it("active:false under an admin hold records idpActive only", async () => {
    const c = await createScimConnection();
    const user = await managedWith(c, { adminHold: true });
    const { status, body } = await setActive(c.token, user.id, false);
    expect(status).toBe(200);
    expect(body.active).toBe(false);
    expect(await activeState(user.id)).toEqual({
      isActive: false,
      idpActive: false,
      adminHold: true,
    });
    expect(await userEntries(user.id)).toHaveLength(0);
  });

  it.each([
    ["active:true on an active user", true],
    ["active:false on an inactive user", false],
  ])("%s changes nothing", async (_, active) => {
    const c = await createScimConnection();
    const user = await managedWith(c, { idpActive: active });
    const withLink = () =>
      prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        include: { scimLink: true },
      });
    const before = await withLink();
    const { status, body } = await setActive(c.token, user.id, active);
    expect(status).toBe(200);
    expect(body.active).toBe(active);
    expect(await withLink()).toEqual(before);
    expect(await userEntries(user.id)).toHaveLength(0);
  });

  it("adopts and deactivates an unmanaged active user", async () => {
    const c = await createScimConnection();
    const user = await makeUser(`free-${tag()}@${c.domain}`);
    const { status, body } = await setActive(c.token, user.id, false);
    expect(status).toBe(200);
    expect(body.active).toBe(false);
    expect(await activeState(user.id)).toEqual({
      isActive: false,
      idpActive: false,
      adminHold: false,
    });
    const actions = (await userEntries(user.id)).map(
      (e) => (e.metadata as { action?: string } | null)?.action ?? null
    );
    expect(actions.sort()).toEqual([null, "scim_adopted"].sort());
  });

  // users.is_active = idp_active AND NOT admin_hold, after every operation.
  it.each([
    ["active", { idpActive: true }, false],
    ["inactive", { idpActive: false }, true],
    ["held", { idpActive: false, adminHold: true }, true],
    ["held and active at the IdP", { idpActive: true, adminHold: true }, false],
  ])("keeps the invariant for a %s user", async (_, link, active) => {
    const c = await createScimConnection();
    const user = await managedWith(c, link);
    expect((await setActive(c.token, user.id, active)).status).toBe(200);
    const s = await activeState(user.id);
    expect(s.isActive).toBe(s.idpActive === true && s.adminHold === false);
  });
});
