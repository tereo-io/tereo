// @module-tag int
// @module-tag auth
import { DEFAULT_ORGANIZATION_ID } from "../../../../../definitions/index.js";
import { GUEST_DEFAULT_ROLES_KEY } from "../../../../../utils/guestRoles.js";
import { cleanNotifications } from "../../../../support/notifications.js";
import { getAccessTokenForUser } from "../../../../support/auth/login.js";
import { createTestClient } from "../../../../support/auth/clients.js";
import { generateUniqueId } from "../../../../support/auth/crypto.js";
import { createTestGuest } from "../../../../support/auth/guests.js";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { BASE_URL } from "../../../../support/auth/constants.js";
import { verifyPassword } from "../../../../../utils/crypto.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../support/http.js";
import { randomUUID } from "node:crypto";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../../support/principals.js";
import {
  createAdminUser,
  createTestPermission,
  createTestRole,
  createTestUser,
} from "../../../../support/auth/users.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../support/webhooks.js";

const DAY_MS = 86_400_000;
const PASSWORD = "GuestPassword123!";

let adminToken: string;
let orgId: string;
let otherOrgId: string;

beforeAll(async () => {
  const client = await createTestClient();
  adminToken = await getAccessTokenForUser(await createAdminUser(), client);
  orgId = await ensureTestOrganization("guests-invite");
  otherOrgId = await ensureTestOrganization("guests-invite-other");
});

afterEach(async () => {
  await prisma.systemSetting.deleteMany({
    where: { key: GUEST_DEFAULT_ROLES_KEY },
  });
});

const invite = (body: Record<string, unknown>, token = adminToken) =>
  fetchJson("POST", `${BASE_URL}/v1/admin/guests`, token, {
    organizationId: orgId,
    expiresIn: 86_400,
    initialAccess: { type: "password_setup_link" },
    ...body,
  });

const uniqueEmail = () => `guest-${generateUniqueId()}@example.com`;

/** A custom role a guest may hold: one org-assignable permission. */
const createGuestRole = async (guestAssignable = true) => {
  const permission = await createTestPermission();
  await prisma.permission.update({
    where: { id: permission.id },
    data: { orgAssignable: true },
  });
  const role = await createTestRole();
  return prisma.role.update({
    where: { id: role.id },
    data: {
      guestAssignable,
      rolePermissions: { create: { permissionId: permission.id } },
    },
  });
};

const setDefaultRoles = (roleIds: string[]) =>
  prisma.systemSetting.upsert({
    where: { key: GUEST_DEFAULT_ROLES_KEY },
    update: { value: JSON.stringify(roleIds) },
    create: { key: GUEST_DEFAULT_ROLES_KEY, value: JSON.stringify(roleIds) },
  });

const orgRoleIds = async (userId: string) =>
  (
    await prisma.userRole.findMany({
      where: { userId },
      select: { roleId: true, organizationId: true },
    })
  )
    .map((ur) => {
      expect(ur.organizationId).toBe(orgId);
      return ur.roleId;
    })
    .sort();

/** Waits for the event's delivery and returns its `data`. */
const expectDelivery = async (
  endpointId: string,
  eventType: string,
  id: string
) => {
  const where = {
    webhookEndpointId: endpointId,
    eventType,
    payload: { path: ["entityId"], equals: id },
  };
  await waitFor(
    async () => (await prisma.webhookDelivery.count({ where })) > 0,
    10_000
  );
  const delivery = await prisma.webhookDelivery.findFirstOrThrow({ where });
  return (delivery.payload as { data: Record<string, unknown> }).data;
};

describe("POST /v1/admin/guests", () => {
  it("creates a guest", async () => {
    const role = await createGuestRole();
    await setDefaultRoles([role.id]);
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(orgId),
      { eventTypes: ["auth.guest.invited"] }
    );
    const platform = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      {
        eventTypes: [
          "auth.user.created",
          "auth.organization.member-added",
          "auth.organization.member-roles-changed",
        ],
      }
    );
    const email = uniqueEmail();

    const res = await invite({ email, name: "Jane" });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.passwordSetupUrl).toMatch(/\/set-password#token=/);
    expect(res.body.user).toMatchObject({
      email,
      name: "Jane",
      userType: "guest",
      status: "active",
      hasPassword: false,
      organizationId: orgId,
    });
    const id = res.body.user.id as string;
    const membership = await prisma.organizationMember.findMany({
      where: { userId: id },
    });
    expect(membership).toEqual([
      expect.objectContaining({ organizationId: orgId, memberRole: "member" }),
    ]);
    expect(await orgRoleIds(id)).toEqual([role.id]);
    expect(
      await prisma.auditLogEntry.count({
        where: {
          entityId: id,
          action: "CREATE",
          metadata: { path: ["action"], equals: "guest_invited" },
        },
      })
    ).toBe(1);
    await expectDelivery(endpoint.id, "auth.guest.invited", id);
    // The user, membership and roles are recorded as their own endpoints
    // record them.
    expect(
      await expectDelivery(platform.id, "auth.user.created", id)
    ).toMatchObject({ id, email, userType: "guest" });
    const member = membership[0];
    expect(
      await expectDelivery(
        platform.id,
        "auth.organization.member-added",
        member.id
      )
    ).toMatchObject({
      organizationId: orgId,
      userId: id,
      memberRole: "member",
    });
    expect(
      await expectDelivery(
        platform.id,
        "auth.organization.member-roles-changed",
        member.id
      )
    ).toMatchObject({ organizationId: orgId, userId: id, roleIds: [role.id] });
    const memberEntries = await prisma.auditLogEntry.findMany({
      where: { entityType: "OrganizationMember", entityId: member.id },
      select: { action: true, metadata: true },
    });
    expect(memberEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "CREATE" }),
        expect.objectContaining({
          action: "UPDATE",
          metadata: expect.objectContaining({
            action: "roles_changed",
            roleIds: [role.id],
          }),
        }),
      ])
    );
  });

  it("sends guest events to the guest's organization, not the default one", async () => {
    const theirs = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(orgId),
      { eventTypes: ["auth.guest.invited"] }
    );
    const platform = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["auth.guest.invited"] }
    );

    const res = await invite({ email: uniqueEmail() });

    expect(res.status).toBe(201);
    await expectDelivery(theirs.id, "auth.guest.invited", res.body.user.id);
    // Deliveries of one event are written together.
    expect(
      await prisma.webhookDelivery.count({
        where: {
          webhookEndpointId: platform.id,
          payload: { path: ["entityId"], equals: res.body.user.id },
        },
      })
    ).toBe(0);
  });

  it("assigns the named roles, by name or id, instead of the defaults", async () => {
    const byName = await createGuestRole();
    const byId = await createGuestRole();
    await setDefaultRoles([(await createGuestRole()).id]);

    const res = await invite({
      email: uniqueEmail(),
      roles: [byName.name, byId.id],
    });

    expect(res.status).toBe(201);
    expect(await orgRoleIds(res.body.user.id)).toEqual(
      [byName.id, byId.id].sort()
    );
  });

  it("skips default roles that are no longer guest-assignable", async () => {
    const live = await createGuestRole();
    const unflagged = await createGuestRole(false);
    const archived = await createGuestRole();
    await prisma.role.update({
      where: { id: archived.id },
      data: { archivedAt: new Date() },
    });
    await setDefaultRoles([live.id, unflagged.id, archived.id]);

    const res = await invite({ email: uniqueEmail() });

    expect(res.status).toBe(201);
    expect(await orgRoleIds(res.body.user.id)).toEqual([live.id]);
  });

  it("no roles and no defaults gives a guest with none", async () => {
    const res = await invite({ email: uniqueEmail() });
    expect(res.status).toBe(201);
    expect(await orgRoleIds(res.body.user.id)).toEqual([]);
  });

  it("same-org guest is extended", async () => {
    const held = await createGuestRole();
    const added = await createGuestRole();
    const { user } = await createTestGuest({
      organizationId: orgId,
      expiresAt: new Date(Date.now() + DAY_MS),
      password: PASSWORD,
      roleIds: [held.id],
    });
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(orgId),
      { eventTypes: ["auth.guest.extended"] }
    );
    const later = new Date(Date.now() + 10 * DAY_MS);

    const res = await invite({
      email: user.email,
      expiresIn: undefined,
      expiresAt: later.toISOString(),
      roles: [added.id],
      initialAccess: { type: "password", password: "OtherPassword123!" },
    });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect(res.body).not.toHaveProperty("passwordSetupUrl");
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.user.expiresAt).toBe(later.toISOString());
    expect(await orgRoleIds(user.id)).toEqual([held.id, added.id].sort());
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(await verifyPassword(after.passwordHash!, PASSWORD)).toBe(true);
    expect(
      await expectDelivery(endpoint.id, "auth.guest.extended", user.id)
    ).toMatchObject({
      id: user.id,
      organizationId: orgId,
      previousExpiresAt: user.expiresAt!.toISOString(),
      expiresAt: later.toISOString(),
      rolesAdded: [added.id],
      change: "extended",
    });
    const member = await prisma.organizationMember.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(
      await prisma.auditLogEntry.findFirst({
        where: {
          entityId: member.id,
          metadata: { path: ["action"], equals: "roles_changed" },
        },
        select: { metadata: true },
      })
    ).toMatchObject({
      metadata: { roleIds: expect.arrayContaining([held.id, added.id]) },
    });

    // An earlier expiry keeps the later one.
    const earlier = await invite({ email: user.email, expiresIn: 3600 });
    expect(earlier.status).toBe(200);
    expect(earlier.body.user.expiresAt).toBe(later.toISOString());
  });

  it("gives initial access to an extended guest who never set a password", async () => {
    const first = await invite({ email: uniqueEmail() });
    const res = await invite({
      email: first.body.user.email,
      initialAccess: { type: "password", password: PASSWORD },
    });
    expect(res.status).toBe(200);
    expect(res.body.user.hasPassword).toBe(true);
    expect(res.body.user.passwordChangeRequired).toBe(true);
  });

  it("password initial access voids the guest's live setup link", async () => {
    const first = await invite({ email: uniqueEmail() });
    expect(first.body.passwordSetupUrl).toBeDefined();

    const res = await invite({
      email: first.body.user.email,
      initialAccess: { type: "password", password: PASSWORD },
    });

    expect(res.status).toBe(200);
    expect(
      await prisma.passwordSetupToken.count({
        where: { userId: first.body.user.id, usedAt: null },
      })
    ).toBe(0);
  });

  it("normalizes email before matching", async () => {
    const email = uniqueEmail();
    const first = await invite({ email });

    const res = await invite({ email: `  ${email.toUpperCase()} ` });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect(res.body.user.id).toBe(first.body.user.id);
    expect(res.body.user.email).toBe(email);
  });

  it("concurrent invites create one guest", async () => {
    const email = uniqueEmail();

    const results = await Promise.all([invite({ email }), invite({ email })]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(
      await prisma.organizationMember.count({ where: { userId: user.id } })
    ).toBe(1);
  });

  it("guest in another organization is refused", async () => {
    const { user } = await createTestGuest({ organizationId: otherOrgId });
    const res = await invite({ email: user.email });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("guest_in_other_organization");
  });

  it("re-invites a guest with no membership into the organization", async () => {
    const { user } = await createTestGuest({ organizationId: otherOrgId });
    await prisma.organizationMember.deleteMany({ where: { userId: user.id } });

    const res = await invite({ email: user.email });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect(res.body.user.id).toBe(user.id);
    const memberships = await prisma.organizationMember.findMany({
      where: { userId: user.id },
    });
    expect(memberships).toEqual([
      expect.objectContaining({ organizationId: orgId, memberRole: "member" }),
    ]);
    expect(
      await prisma.auditLogEntry.count({
        where: {
          entityType: "OrganizationMember",
          entityId: memberships[0].id,
          action: "CREATE",
        },
      })
    ).toBe(1);
  });

  it("re-invites a guest whose organization was archived", async () => {
    const archived = await ensureTestOrganization(
      `guests-archived-${generateUniqueId()}`
    );
    const { user } = await createTestGuest({ organizationId: archived });
    await prisma.organization.update({
      where: { id: archived },
      data: { isActive: false, archivedAt: new Date() },
    });

    const res = await invite({ email: user.email });

    expect(res.status).toBe(200);
    expect(res.body.user.organizationId).toBe(orgId);
  });

  describe("a guest in no organization, invited without organizations.write", () => {
    const callerIn = async (permissions: string[]) => {
      const userId = randomUUID();
      const token = await getTestPrincipalToken({
        userId,
        organizationId: orgId,
        permissions,
      });
      await prisma.organizationMember.create({
        data: { organizationId: orgId, userId, memberRole: "member" },
      });
      return token;
    };
    const unassignedGuest = async () => {
      const { user } = await createTestGuest({ organizationId: otherOrgId });
      await prisma.organizationMember.deleteMany({
        where: { userId: user.id },
      });
      return user;
    };

    it("is refused with guest_unassigned, joining nothing", async () => {
      const user = await unassignedGuest();
      const token = await callerIn(["users.guests.write", "users.read"]);

      const res = await invite({ email: user.email }, token);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("guest_unassigned");
      expect(
        await prisma.organizationMember.count({ where: { userId: user.id } })
      ).toBe(0);
    });

    it("is refused as email_unavailable without users.read", async () => {
      const user = await unassignedGuest();
      const token = await callerIn(["users.guests.write"]);
      const res = await invite({ email: user.email }, token);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("email_unavailable");
    });
  });

  describe("a caller without users.read", () => {
    let token: string;
    beforeAll(async () => {
      const userId = randomUUID();
      token = await getTestPrincipalToken({
        userId,
        organizationId: orgId,
        permissions: ["users.guests.write"],
      });
      await prisma.organizationMember.create({
        data: { organizationId: orgId, userId, memberRole: "member" },
      });
    });

    it.each([
      ["a human", async () => createTestUser()],
      [
        "a guest in another organization",
        async () =>
          (await createTestGuest({ organizationId: otherOrgId })).user,
      ],
      ["a deactivated user", () => createTestUser({ isActive: false })],
    ])(
      "gets one email_unavailable for %s, without their id",
      async (_label, make) => {
        const user = await make();
        const res = await invite({ email: user.email }, token);
        expect(res.status).toBe(409);
        expect(res.body.error).toBe("email_unavailable");
        expect(res.body).not.toHaveProperty("userId");
      }
    );
  });

  it("refuses an inactive organization", async () => {
    const inactive = await ensureTestOrganization("guests-invite-inactive");
    await prisma.organization.update({
      where: { id: inactive },
      data: { isActive: false },
    });
    const email = uniqueEmail();
    const res = await invite({ email, organizationId: inactive });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("organization_inactive");
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it("human is refused with their id", async () => {
    const human = await createTestUser();
    const res = await invite({ email: human.email });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "user_exists", userId: human.id });
  });

  it.each([
    [
      "a service account",
      () =>
        prisma.user.create({
          data: {
            email: uniqueEmail(),
            userType: "service_account",
          },
        }),
    ],
    ["a deactivated user", () => createTestUser({ isActive: false })],
    [
      "a deactivated guest",
      async () => {
        const { user } = await createTestGuest({ organizationId: orgId });
        return prisma.user.update({
          where: { id: user.id },
          data: { isActive: false },
        });
      },
    ],
  ])("%s is refused as not invitable", async (_label, make) => {
    const user = await make();
    const res = await invite({ email: user.email });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("user_not_invitable");
  });

  it.each([
    ["a role that is not guest-assignable", () => createGuestRole(false)],
    [
      "a system role",
      async () => {
        const role = await createTestRole({ isSystem: true });
        return role;
      },
    ],
    [
      "a flagged role holding a permission that is not org-assignable",
      async () => {
        const role = await createGuestRole();
        const permission = await createTestPermission();
        await prisma.rolePermission.create({
          data: { roleId: role.id, permissionId: permission.id },
        });
        return role;
      },
    ],
  ])("refuses %s", async (_label, make) => {
    const role = await make();
    const email = uniqueEmail();
    const res = await invite({ email, roles: [role.id] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("role_not_guest_assignable");
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it("refuses an unknown role", async () => {
    const res = await invite({
      email: uniqueEmail(),
      roles: ["no-such-role-anywhere"],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_role");
  });

  it("password with mustChange sets passwordChangeRequired", async () => {
    const res = await invite({
      email: uniqueEmail(),
      initialAccess: { type: "password", password: PASSWORD, mustChange: true },
    });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("passwordSetupUrl");
    expect(res.body.user).toMatchObject({
      hasPassword: true,
      passwordChangeRequired: true,
    });
  });

  it("password with mustChange false leaves it unset", async () => {
    const res = await invite({
      email: uniqueEmail(),
      initialAccess: {
        type: "password",
        password: PASSWORD,
        mustChange: false,
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.user.passwordChangeRequired).toBe(false);
  });

  it("refuses notify without an email connection, creating nothing", async () => {
    await cleanNotifications();
    const email = uniqueEmail();
    const res = await invite({
      email,
      initialAccess: { type: "password_setup_link", notify: true },
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("email_not_configured");
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it("returns core's 400 for an invalid body", async () => {
    const res = await invite({ email: uniqueEmail(), expiresIn: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("allows a caller holding only users.guests.write to give guest roles it does not hold", async () => {
    const userId = randomUUID();
    const token = await getTestPrincipalToken({
      userId,
      organizationId: orgId,
      permissions: ["users.guests.write"],
    });
    await prisma.organizationMember.create({
      data: { organizationId: orgId, userId, memberRole: "member" },
    });
    const role = await createGuestRole();
    const res = await invite({ email: uniqueEmail(), roles: [role.id] }, token);
    expect(res.status).toBe(201);
    expect(await orgRoleIds(res.body.user.id)).toEqual([role.id]);
  });

  it("refuses a caller outside the target organization, creating nothing", async () => {
    const token = await getTestPrincipalToken({
      organizationId: orgId,
      permissions: ["users.guests.write"],
    });
    const email = uniqueEmail();
    const res = await invite({ email }, token);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("organization_not_permitted");
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it("refuses to extend a guest in an organization the caller is outside", async () => {
    const { user } = await createTestGuest({ organizationId: orgId });
    const token = await getTestPrincipalToken({
      organizationId: orgId,
      permissions: ["users.guests.write"],
    });
    const res = await invite({ email: user.email }, token);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("organization_not_permitted");
  });

  it("allows a service account whose client belongs to the organization", async () => {
    const client = await createTestClient({
      clientType: "confidential",
      grantTypes: ["client_credentials"],
    });
    await prisma.oAuthClient.update({
      where: { id: client.id },
      data: { organizationId: orgId },
    });
    const account = await prisma.user.findFirstOrThrow({
      where: { oauthClientId: client.id },
    });
    const token = await getTestPrincipalToken({
      userId: account.id,
      permissions: ["users.guests.write"],
    });
    const res = await invite({ email: uniqueEmail() }, token);
    expect(res.status).toBe(201);
  });
});

describe("GET /v1/admin/guests", () => {
  it("lists only guests, filtered by organization", async () => {
    const mine = await createTestGuest({ organizationId: orgId });
    const theirs = await createTestGuest({ organizationId: otherOrgId });

    const res = await fetchJson(
      "GET",
      `${BASE_URL}/v1/admin/guests?filter[organizationId]=${otherOrgId}&limit=200`,
      adminToken
    );

    expect(res.status).toBe(200);
    const ids = res.body.data.map((u: { id: string }) => u.id);
    expect(ids).toContain(theirs.user.id);
    expect(ids).not.toContain(mine.user.id);
    expect(
      res.body.data.find((u: { id: string }) => u.id === theirs.user.id)
        .organizationId
    ).toBe(otherOrgId);
    // Expired guests from earlier runs stay in the fixed test org; only this
    // test's own row is asserted active.
    for (const user of res.body.data) expect(user.userType).toBe("guest");
    expect(
      res.body.data.find((u: { id: string }) => u.id === theirs.user.id).status
    ).toBe("active");
  });

  it("shows a caller without organizations.write only their organizations' guests", async () => {
    const mine = await createTestGuest({ organizationId: orgId });
    const theirs = await createTestGuest({ organizationId: otherOrgId });
    const userId = randomUUID();
    const token = await getTestPrincipalToken({
      userId,
      permissions: ["users.guests.read"],
    });
    await prisma.organizationMember.create({
      data: { organizationId: orgId, userId, memberRole: "member" },
    });

    const res = await fetchJson(
      "GET",
      `${BASE_URL}/v1/admin/guests?limit=200&sort=createdAt&sortDir=desc`,
      token
    );

    expect(res.status).toBe(200);
    const ids = res.body.data.map((u: { id: string }) => u.id);
    expect(ids).toContain(mine.user.id);
    expect(ids).not.toContain(theirs.user.id);
  });
});
