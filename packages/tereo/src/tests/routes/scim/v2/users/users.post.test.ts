// @module-tag int
// @module-tag auth
import { createScimConnection, scimFetch } from "../../../../support/scim.js";
import { makeUser, manage, tag } from "../../../../support/scimUsers.js";
import { entraUpnCreateUser } from "../../../../fixtures/scim/entra.js";
import { createTestRole } from "../../../../support/auth/users.js";
import { oktaCreateUser } from "../../../../fixtures/scim/okta.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../support/coreUrl.js";
import { describe, expect, it } from "vitest";

const post = (token: string, body: unknown) =>
  scimFetch(token, "POST", "/scim/v2/Users", body);

const withEmail = <T extends object>(
  fixture: T,
  email: string,
  userName = email
) => ({
  ...fixture,
  userName,
  emails: [{ primary: true, type: "work", value: email }],
});

const expectUniqueness = (r: { status: number; body: unknown }) => {
  expect(r.status).toBe(409);
  expect(r.body).toMatchObject({ status: "409", scimType: "uniqueness" });
};

const expectInvalidValue = (r: { status: number; body: unknown }) => {
  expect(r.status).toBe(400);
  expect(r.body).toMatchObject({ status: "400", scimType: "invalidValue" });
};

describe("POST /scim/v2/Users — create", () => {
  it("creates an Okta user without a password, as a member with the domain's default roles", async () => {
    const role = await createTestRole();
    const c = await createScimConnection({ roleIds: [role.id] });
    // The domain does not auto-accept sign-ins; SCIM creates regardless.
    await prisma.identityProviderDomain.update({
      where: { domain: c.domain },
      data: { autoAccept: false },
    });
    const email = `new-${tag()}@${c.domain}`;
    const response = await fetch(`${CORE_URL}/scim/v2/Users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.token}`,
        "Content-Type": "application/scim+json",
      },
      body: JSON.stringify({
        ...withEmail(oktaCreateUser, email),
        password: "Ignored-Passw0rd!",
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown> & {
      id: string;
      meta: { location: string };
    };

    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      include: { scimLink: true },
    });
    expect(body.id).toBe(user.id);
    expect(response.headers.get("location")).toBe(body.meta.location);
    expect(body.meta.location).toMatch(new RegExp(`/Users/${user.id}$`));
    expect(body).toMatchObject({
      userName: email,
      externalId: oktaCreateUser.externalId,
      displayName: "Jane Doe",
      name: { givenName: "Jane", familyName: "Doe" },
      active: true,
    });
    expect(user.passwordHash).toBeNull();
    expect(user).toMatchObject({
      firstName: "Jane",
      lastName: "Doe",
      name: "Jane Doe",
      isActive: true,
    });
    expect(user.scimLink).toMatchObject({
      connectionId: c.connectionId,
      userName: email,
      externalId: oktaCreateUser.externalId,
      idpActive: true,
      adminHold: false,
      deletedAt: null,
    });

    const member = await prisma.organizationMember.findFirstOrThrow({
      where: { organizationId: c.organizationId, userId: user.id },
    });
    expect(member.memberRole).toBe("member");
    const roles = await prisma.userRole.findMany({
      where: { organizationId: c.organizationId, userId: user.id },
    });
    expect(roles.map((r) => r.roleId)).toEqual([role.id]);
  });

  it("creates an Entra user whose userName is a UPN", async () => {
    const c = await createScimConnection();
    const email = `upn-${tag()}@${c.domain}`;
    const { status, body } = await post(
      c.token,
      withEmail(entraUpnCreateUser, email, "jdoe")
    );
    expect(status).toBe(201);
    expect(body).toMatchObject({
      userName: "jdoe",
      emails: [{ value: email, primary: true }],
      externalId: entraUpnCreateUser.externalId,
    });
    const link = await prisma.scimUser.findUniqueOrThrow({
      where: { userId: body.id },
    });
    expect(link.userName).toBe("jdoe");
  });

  it("records active:false from the IdP on a new user", async () => {
    const c = await createScimConnection();
    const email = `off-${tag()}@${c.domain}`;
    const { status, body } = await post(c.token, {
      ...withEmail(oktaCreateUser, email),
      active: false,
    });
    expect(status).toBe(201);
    const link = await prisma.scimUser.findUniqueOrThrow({
      where: { userId: body.id },
    });
    expect(link).toMatchObject({ idpActive: false, adminHold: false });
  });

  it("refuses an archived organization with 400 invalidValue", async () => {
    const c = await createScimConnection();
    await prisma.organization.update({
      where: { id: c.organizationId },
      data: { archivedAt: new Date() },
    });
    const email = `arch-${tag()}@${c.domain}`;
    expectInvalidValue(await post(c.token, withEmail(oktaCreateUser, email)));
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("refuses an inactive organization with 400 invalidValue", async () => {
    const c = await createScimConnection();
    await prisma.organization.update({
      where: { id: c.organizationId },
      data: { isActive: false },
    });
    const email = `idle-${tag()}@${c.domain}`;
    expectInvalidValue(await post(c.token, withEmail(oktaCreateUser, email)));
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("refuses an email outside the provider's domains with 400 invalidValue", async () => {
    const c = await createScimConnection();
    const other = await createScimConnection();
    const email = `out-${tag()}@${other.domain}`;
    expectInvalidValue(await post(c.token, withEmail(oktaCreateUser, email)));
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("refuses a userName with no emails that is not an email address (Review Focus 5)", async () => {
    const c = await createScimConnection();
    const r = await post(c.token, {
      schemas: oktaCreateUser.schemas,
      userName: "jdoe",
    });
    expectInvalidValue(r);
    expect(r.body.detail).toContain("emails");
  });

  it("refuses a userName or externalId this connection holds, even on a deleted link", async () => {
    const c = await createScimConnection();
    const held = await makeUser(`held-${tag()}@${c.domain}`);
    await manage(c.connectionId, held.id, "Taken.Name", {
      externalId: "taken-ext",
      deletedAt: new Date(),
    });
    const email = `fresh-${tag()}@${c.domain}`;
    expectUniqueness(
      await post(c.token, {
        ...withEmail(oktaCreateUser, email, "taken.name"),
        externalId: null,
      })
    );
    expectUniqueness(
      await post(c.token, {
        ...withEmail(oktaCreateUser, email),
        externalId: "taken-ext",
      })
    );
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });
});

describe("POST /scim/v2/Users — existing accounts", () => {
  it("adopts an unmanaged in-domain user, leaving roles and password alone", async () => {
    const role = await createTestRole();
    const c = await createScimConnection();
    const user = await makeUser(`adopt-${tag()}@${c.domain}`);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: "$argon2id$unchanged" },
    });
    await prisma.organizationMember.create({
      data: { organizationId: c.organizationId, userId: user.id },
    });
    await prisma.userRole.create({
      data: {
        organizationId: c.organizationId,
        userId: user.id,
        roleId: role.id,
      },
    });

    const { status, body } = await post(
      c.token,
      withEmail(oktaCreateUser, user.email)
    );
    expect(status).toBe(201);
    expect(body).toMatchObject({
      id: user.id,
      userName: user.email,
      externalId: oktaCreateUser.externalId,
      displayName: "Jane Doe",
      active: true,
    });

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { scimLink: true },
    });
    expect(after.passwordHash).toBe("$argon2id$unchanged");
    expect(after).toMatchObject({ firstName: "Jane", lastName: "Doe" });
    expect(after.scimLink).toMatchObject({
      connectionId: c.connectionId,
      idpActive: true,
      adminHold: false,
    });
    const roles = await prisma.userRole.findMany({
      where: { userId: user.id },
    });
    expect(roles.map((r) => r.roleId)).toEqual([role.id]);
    const adopted = await prisma.auditLogEntry.findMany({
      where: {
        entityId: user.id,
        metadata: { path: ["action"], equals: "scim_adopted" },
      },
    });
    expect(adopted).toHaveLength(1);
  });

  it("adopts an inactive user with active:true under an admin hold (Review Focus 2)", async () => {
    const c = await createScimConnection();
    const user = await makeUser(`held-${tag()}@${c.domain}`, {
      isActive: false,
    });
    const { status, body } = await post(c.token, {
      ...withEmail(oktaCreateUser, user.email),
      active: true,
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({ id: user.id, active: false });
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { scimLink: true },
    });
    expect(after.isActive).toBe(false);
    expect(after.scimLink).toMatchObject({ adminHold: true, idpActive: true });
  });

  it("refuses with 409 uniqueness, identically, every account it cannot see", async () => {
    const c = await createScimConnection();
    const other = await createScimConnection({ domains: [`o-${tag()}.test`] });
    const outside = await createScimConnection();
    const guest = await makeUser(`g-${tag()}@${c.domain}`, {
      userType: "guest",
    });
    const service = await makeUser(`s-${tag()}@${c.domain}`, {
      userType: "service_account",
    });
    const theirs = await makeUser(`t-${tag()}@${c.domain}`);
    await manage(other.connectionId, theirs.id, theirs.email);
    const deletedElsewhere = await makeUser(`d-${tag()}@${c.domain}`);
    await manage(other.connectionId, deletedElsewhere.id, "gone", {
      deletedAt: new Date(),
    });
    const notInDomain = await makeUser(`n-${tag()}@${outside.domain}`);

    const bodies: unknown[] = [];
    for (const u of [guest, service, theirs, deletedElsewhere, notInDomain]) {
      const r = await post(c.token, {
        ...withEmail(oktaCreateUser, u.email),
        externalId: null,
      });
      expectUniqueness(r);
      bodies.push(r.body);
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(
      await prisma.scimUser.count({ where: { connectionId: c.connectionId } })
    ).toBe(0);
  });

  it("refuses a second POST for a user it manages", async () => {
    const c = await createScimConnection();
    const email = `twice-${tag()}@${c.domain}`;
    const first = await post(c.token, withEmail(oktaCreateUser, email));
    expect(first.status).toBe(201);
    expectUniqueness(await post(c.token, withEmail(oktaCreateUser, email)));
  });

  it("refuses a new email under an externalId it already manages", async () => {
    const c = await createScimConnection();
    const first = await post(
      c.token,
      withEmail(oktaCreateUser, `a-${tag()}@${c.domain}`)
    );
    expect(first.status).toBe(201);
    expectUniqueness(
      await post(c.token, withEmail(oktaCreateUser, `b-${tag()}@${c.domain}`))
    );
  });

  it("revives a deleted link and applies the body", async () => {
    const c = await createScimConnection();
    const user = await makeUser(`back-${tag()}@${c.domain}`);
    await manage(c.connectionId, user.id, "Old.Name", {
      externalId: "old",
      deletedAt: new Date(),
    });
    const { status, body } = await post(
      c.token,
      withEmail(oktaCreateUser, user.email)
    );
    expect(status).toBe(201);
    expect(body).toMatchObject({
      id: user.id,
      userName: user.email,
      externalId: oktaCreateUser.externalId,
    });
    const link = await prisma.scimUser.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(link).toMatchObject({
      deletedAt: null,
      userName: user.email,
      externalId: oktaCreateUser.externalId,
    });
  });
});
