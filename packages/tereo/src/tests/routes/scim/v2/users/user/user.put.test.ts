// @module-tag int
// @module-tag auth
import { DEFAULT_ORGANIZATION_ID } from "../../../../../../definitions/index.js";
import { createTestClient } from "../../../../../support/auth/clients.js";
import { entraReplaceUser } from "../../../../../fixtures/scim/entra.js";
import { oktaReplaceUser } from "../../../../../fixtures/scim/okta.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  REDIRECT_URI,
  sessionLifecycleHelpers,
} from "../../../../../support/auth/sessionLifecycle.js";
import {
  activeState,
  makeUser,
  manage,
  signedInManagedUser,
  tag,
} from "../../../../../support/scimUsers.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../../support/webhooks.js";
import {
  createScimConnection,
  scimFetch,
} from "../../../../../support/scim.js";

let client: Awaited<ReturnType<typeof createTestClient>>;
const { login, refresh } = sessionLifecycleHelpers(() => client);

beforeAll(async () => {
  client = await createTestClient({ redirectUris: [REDIRECT_URI] });
});

const put = (token: string, id: string, body: unknown) =>
  scimFetch(token, "PUT", `/scim/v2/Users/${id}`, body);

const replacing = (
  email: string,
  over: Record<string, unknown> = {},
  fixture: Record<string, unknown> = oktaReplaceUser
) => ({
  ...fixture,
  userName: email,
  emails: [{ primary: true, type: "work", value: email }],
  ...over,
});

const userEntries = (userId: string) =>
  prisma.auditLogEntry.findMany({
    where: { entityType: "User", entityId: userId },
    orderBy: { createdAt: "asc" },
  });

const expectInvalidValue = (r: { status: number; body: unknown }) => {
  expect(r.status).toBe(400);
  expect(r.body).toMatchObject({ status: "400", scimType: "invalidValue" });
};

const expectUniqueness = (r: { status: number; body: unknown }) => {
  expect(r.status).toBe(409);
  expect(r.body).toMatchObject({ status: "409", scimType: "uniqueness" });
};

const managedUser = async (
  c: { connectionId: string; domain: string },
  data: { firstName?: string; lastName?: string } = {}
) => {
  const user = await makeUser(`m-${tag()}@${c.domain}`);
  await prisma.user.update({ where: { id: user.id }, data });
  const link = await manage(c.connectionId, user.id, user.email);
  return { user, link };
};

describe("PUT /scim/v2/Users/:id", () => {
  it("replaces the profile: a name attribute left out is cleared", async () => {
    const c = await createScimConnection();
    const { user } = await managedUser(c, {
      firstName: "Jane",
      lastName: "Doe",
    });
    const { status, body } = await put(
      c.token,
      user.id,
      replacing(user.email, {
        name: { givenName: "Janet" },
        displayName: undefined,
      })
    );
    expect(status).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row).toMatchObject({
      firstName: "Janet",
      lastName: null,
      name: "Janet",
    });
    expect(body).toMatchObject({
      id: user.id,
      name: { givenName: "Janet" },
      active: true,
    });
    expect(body.name.familyName).toBeUndefined();
  });

  it.each([
    ["Okta", oktaReplaceUser],
    ["Entra", entraReplaceUser],
  ])("applies the %s replace fixture", async (_, fixture) => {
    const c = await createScimConnection();
    const { user } = await managedUser(c, {
      firstName: "Jane",
      lastName: "Doe",
    });
    const { status, body } = await put(
      c.token,
      user.id,
      replacing(user.email, {}, fixture)
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      displayName: "Jane Smith",
      name: { givenName: "Jane", familyName: "Smith" },
      externalId: fixture.externalId,
    });
    const link = await prisma.scimUser.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(link.externalId).toBe(fixture.externalId);
  });

  it("adopts an unmanaged visible user and applies the body", async () => {
    const c = await createScimConnection();
    const user = await makeUser(`free-${tag()}@${c.domain}`);
    const { status, body } = await put(
      c.token,
      user.id,
      replacing(user.email, { userName: "jsmith" })
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: user.id, userName: "jsmith" });
    const link = await prisma.scimUser.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(link).toMatchObject({
      connectionId: c.connectionId,
      userName: "jsmith",
      externalId: oktaReplaceUser.externalId,
      adminHold: false,
    });
    const entries = await userEntries(user.id);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "scim_adopted" }),
        expect.not.objectContaining({ action: "scim_adopted" }),
      ])
    );
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).name
    ).toBe("Jane Smith");
  });

  it("changes the email inside the domains the way the admin path does", async () => {
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["auth.user.updated"] }
    );
    const c = await createScimConnection();
    const { user } = await managedUser(c, {
      firstName: "Jane",
      lastName: "Smith",
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date(), name: "Jane Smith" },
    });
    await prisma.identityInvite.create({
      data: {
        userId: user.id,
        providerId: c.providerId,
        createdBy: user.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const newEmail = `Moved-${tag()}@${c.domain.toUpperCase()}`;

    const { status, body } = await put(
      c.token,
      user.id,
      replacing(newEmail, { userName: user.email })
    );

    expect(status).toBe(200);
    expect(body.emails).toEqual([
      { value: newEmail.toLowerCase(), type: "work", primary: true },
    ]);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.email).toBe(newEmail.toLowerCase());
    expect(row.emailVerifiedAt).toBeNull();
    expect(
      await prisma.identityInvite.count({ where: { userId: user.id } })
    ).toBe(0);
    const entries = await userEntries(user.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "UPDATE" });
    expect(entries[0].metadata).toMatchObject({
      scimConnectionId: c.connectionId,
      invitesWithdrawn: 1,
    });
    const where = {
      webhookEndpointId: endpoint.id,
      eventType: "auth.user.updated",
      payload: { path: ["entityId"], equals: user.id },
    };
    await waitFor(
      async () => (await prisma.webhookDelivery.count({ where })) > 0,
      10_000
    );
    expect(await prisma.webhookDelivery.count({ where })).toBe(1);
  });

  it("answers 409 uniqueness for an address another user has", async () => {
    const c = await createScimConnection();
    const { user } = await managedUser(c);
    const other = await makeUser(`taken-${tag()}@${c.domain}`);
    expectUniqueness(await put(c.token, user.id, replacing(other.email)));
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email
    ).toBe(user.email);
  });

  it("answers the same 400 for an outside address, taken or not", async () => {
    const c = await createScimConnection();
    const { user } = await managedUser(c);
    const outside = await makeUser(`out-${tag()}@elsewhere-${tag()}.test`);
    const taken = await put(c.token, user.id, replacing(outside.email));
    const free = await put(
      c.token,
      user.id,
      replacing(`free-${tag()}@elsewhere-${tag()}.test`)
    );
    expectInvalidValue(taken);
    expectInvalidValue(free);
    expect(taken.body).toEqual(free.body);
    expect(await userEntries(user.id)).toHaveLength(0);
  });

  it("leaves an unmanaged user unadopted when the change is refused", async () => {
    const c = await createScimConnection();
    const user = await makeUser(`free-${tag()}@${c.domain}`);
    expectInvalidValue(
      await put(c.token, user.id, replacing(`x-${tag()}@elsewhere.test`))
    );
    expect(await prisma.scimUser.count({ where: { userId: user.id } })).toBe(0);
    expect(await userEntries(user.id)).toHaveLength(0);
  });

  it("writes no audit entry for an unchanged body", async () => {
    const c = await createScimConnection();
    const { user } = await managedUser(c);
    const body = replacing(user.email, { externalId: null });
    expect((await put(c.token, user.id, body)).status).toBe(200);
    const before = await userEntries(user.id);
    expect(before).toHaveLength(1);
    const again = await put(c.token, user.id, body);
    expect(again.status).toBe(200);
    expect(await userEntries(user.id)).toHaveLength(1);
  });

  it("changes only the link for a new userName with the same email", async () => {
    const c = await createScimConnection();
    const { user } = await managedUser(c);
    const body = replacing(user.email, { externalId: null });
    await put(c.token, user.id, body);
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    const entries = (await userEntries(user.id)).length;

    const { status, body: res } = await put(c.token, user.id, {
      ...body,
      userName: "renamed",
    });

    expect(status).toBe(200);
    expect(res.userName).toBe("renamed");
    const link = await prisma.scimUser.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(link.userName).toBe("renamed");
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    ).toEqual(before);
    expect(await userEntries(user.id)).toHaveLength(entries);
  });

  it("answers 409 uniqueness for a userName another managed user has", async () => {
    const c = await createScimConnection();
    const { user } = await managedUser(c);
    const { user: other } = await managedUser(c);
    expectUniqueness(
      await put(
        c.token,
        user.id,
        replacing(user.email, { userName: other.email })
      )
    );
  });

  it("answers 404 for an invisible user or a malformed id", async () => {
    const c = await createScimConnection();
    const outside = await makeUser(`out-${tag()}@elsewhere-${tag()}.test`);
    for (const id of [outside.id, randomUUID(), "not-a-uuid"]) {
      const r = await put(c.token, id, replacing(`x-${tag()}@${c.domain}`));
      expect(r.status).toBe(404);
    }
  });
});

describe("PUT /scim/v2/Users/:id active", () => {
  it("active:false deactivates; a refresh token issued before is refused", async () => {
    const c = await createScimConnection();
    const { user, tokens } = await signedInManagedUser(c, login);
    const { status, body } = await put(
      c.token,
      user.id,
      replacing(user.email, { active: false })
    );
    expect(status).toBe(200);
    expect(body.active).toBe(false);
    expect(await activeState(user.id)).toEqual({
      isActive: false,
      idpActive: false,
      adminHold: false,
    });
    expect((await refresh(tokens.refresh_token)).status).toBe(400);
  });
});
