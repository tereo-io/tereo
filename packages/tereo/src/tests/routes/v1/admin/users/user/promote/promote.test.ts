// @module-tag int
// @module-tag auth
import { getAccessTokenForUser } from "../../../../../../support/auth/login.js";
import { createTestClient } from "../../../../../../support/auth/clients.js";
import { createTestGuest } from "../../../../../../support/auth/guests.js";
import { BASE_URL } from "../../../../../../support/auth/constants.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../../support/http.js";
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../../../../support/principals.js";
import {
  createAdminUser,
  createTestPermission,
  createTestRole,
  createTestUser,
} from "../../../../../../support/auth/users.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../../../support/webhooks.js";

let adminToken: string;
let orgId: string;

beforeAll(async () => {
  adminToken = await getAccessTokenForUser(
    await createAdminUser(),
    await createTestClient()
  );
  orgId = await ensureTestOrganization("admin-promote");
});

const promote = (id: string, token = adminToken) =>
  fetchJson("POST", `${BASE_URL}/v1/admin/users/${id}/promote`, token);

/** A guest-assignable role carrying one org-assignable permission. */
const createGuestRole = async () => {
  const permission = await createTestPermission();
  await prisma.permission.update({
    where: { id: permission.id },
    data: { orgAssignable: true },
  });
  const role = await createTestRole();
  await prisma.role.update({
    where: { id: role.id },
    data: {
      guestAssignable: true,
      rolePermissions: { create: { permissionId: permission.id } },
    },
  });
  return { role, permission };
};

describe("POST /v1/admin/users/:id/promote", () => {
  it("makes the guest a regular user, keeping id, membership, roles and password", async () => {
    const { role, permission } = await createGuestRole();
    const { user } = await createTestGuest({
      organizationId: orgId,
      roleIds: [role.id],
    });
    // Core's admin does not cover a service's permissions.
    const holder = await getTestPrincipalToken({
      permissions: ["admin", permission.name],
    });
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(orgId),
      { eventTypes: ["auth.guest.promoted"] }
    );

    const res = await promote(user.id, holder);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: user.id,
      userType: "human",
      expiresAt: null,
      status: "active",
      hasPassword: true,
    });
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(after.passwordHash).toBe(user.passwordHash);
    expect(
      await prisma.organizationMember.findMany({ where: { userId: user.id } })
    ).toEqual([
      expect.objectContaining({ organizationId: orgId, memberRole: "member" }),
    ]);
    expect(
      await prisma.userRole.findMany({
        where: { userId: user.id },
        select: { roleId: true, organizationId: true },
      })
    ).toEqual([{ roleId: role.id, organizationId: orgId }]);
    await waitFor(
      async () =>
        (await prisma.webhookDelivery.count({
          where: {
            webhookEndpointId: endpoint.id,
            eventType: "auth.guest.promoted",
            payload: { path: ["entityId"], equals: user.id },
          },
        })) > 0,
      10_000
    );

    // The guest restrictions lift: a global role now follows the human rules.
    const global = await createTestRole();
    const roles = await fetchJson(
      "PUT",
      `${BASE_URL}/v1/admin/users/${user.id}/roles`,
      adminToken,
      { roleIds: [global.id] }
    );
    expect(roles.status).toBe(200);
  });

  it("refuses a caller lacking the guest's permissions", async () => {
    const { role, permission } = await createGuestRole();
    const { user } = await createTestGuest({
      organizationId: orgId,
      roleIds: [role.id],
    });
    const token = await getTestPrincipalToken({ permissions: ["users.write"] });

    const res = await promote(user.id, token);

    expect(res.status).toBe(403);
    expect(res.body.error_description).toContain(permission.name);
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(after.userType).toBe("guest");
  });

  it("returns 404 not_a_guest for a regular user", async () => {
    const human = await createTestUser();
    const res = await promote(human.id);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_a_guest");
  });

  it("revokes a password-only token when the promoted user now needs 2FA", async () => {
    // Not guest-assignable, so it demands nothing of the guest until promoted.
    const role = await createTestRole();
    await prisma.role.update({
      where: { id: role.id },
      data: { requires2fa: true },
    });
    const { user, plainPassword } = await createTestGuest({
      organizationId: orgId,
      roleIds: [role.id],
    });
    const guestToken = await getAccessTokenForUser(
      { id: user.id, email: user.email, plainPassword },
      await createTestClient()
    );
    const before = await fetchJson(
      "GET",
      `${BASE_URL}/v1/account/me`,
      guestToken
    );
    expect(before.status).toBe(200);

    expect((await promote(user.id)).status).toBe(200);

    const after = await fetchJson(
      "GET",
      `${BASE_URL}/v1/account/me`,
      guestToken
    );
    expect(after.status).toBe(401);
    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        entityId: user.id,
        metadata: { path: ["action"], equals: "guest_promoted" },
      },
    });
    expect(entry.metadata).toMatchObject({ accessTokensRevoked: 1 });
  });

  it("lifts the cap on the guest's refresh tokens", async () => {
    const { user } = await createTestGuest({ organizationId: orgId });
    const client = await prisma.oAuthClient.findFirstOrThrow({
      select: { id: true },
    });
    const token = await prisma.refreshToken.create({
      data: {
        tokenHash: `promote-${user.id}`,
        clientId: client.id,
        userId: user.id,
        scopes: ["openid"],
        expiresAt: user.expiresAt!,
      },
    });

    expect((await promote(user.id)).status).toBe(200);

    const after = await prisma.refreshToken.findUniqueOrThrow({
      where: { id: token.id },
    });
    expect(after.expiresAt.getTime()).toBeGreaterThan(
      user.expiresAt!.getTime()
    );
  });
  describe("a password and links someone else chose", () => {
    const invite = (initialAccess: Record<string, unknown>) =>
      fetchJson("POST", `${BASE_URL}/v1/admin/guests`, adminToken, {
        email: `promote-${randomUUID()}@example.com`,
        organizationId: orgId,
        expiresIn: 86_400,
        initialAccess,
      });
    const tokenOf = (url: string) => new URL(url).hash.replace("#token=", "");
    const passwordSetup = (path: string, body: object) =>
      fetchJson("POST", `${BASE_URL}/v1/password-setup${path}`, null, body);

    it.each([false, true])(
      "refuses 409 password_not_user_set while the invite's password stands (mustChange %s)",
      async (mustChange) => {
        const invited = await invite({
          type: "password",
          password: "InvitersPassword123!",
          mustChange,
        });
        expect(invited.status).toBe(201);
        const id = invited.body.user.id;

        const res = await promote(id);

        expect(res.status).toBe(409);
        expect(res.body.error).toBe("password_not_user_set");
        const after = await prisma.user.findUniqueOrThrow({ where: { id } });
        expect(after.userType).toBe("guest");
      }
    );

    it("promotes once the guest has set their own password from a link", async () => {
      const invited = await invite({
        type: "password",
        password: "InvitersPassword123!",
      });
      const id = invited.body.user.id;
      const link = await fetchJson(
        "POST",
        `${BASE_URL}/v1/admin/guests/${id}/password-setup-link`,
        adminToken
      );
      expect(link.status).toBe(200);
      const set = await passwordSetup("", {
        token: tokenOf(link.body.url),
        password: "GuestsOwnPassword123!",
      });
      expect(set.status).toBe(204);

      expect((await promote(id)).status).toBe(200);
    });

    it("retires the guest's setup link and pending password change grants", async () => {
      const invited = await invite({ type: "password_setup_link" });
      const id = invited.body.user.id;
      const token = tokenOf(invited.body.passwordSetupUrl);
      const client = await createTestClient();
      await prisma.passwordChangeGrant.create({
        data: {
          tokenHash: `promote-grant-${id}`,
          cookieSecretHash: `promote-cookie-${id}`,
          userId: id,
          clientId: client.id,
          redirectUri: client.redirectUris[0],
          scopes: ["openid"],
          codeChallenge: "c",
          codeChallengeMethod: "S256",
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      expect((await promote(id)).status).toBe(200);

      expect((await passwordSetup("/inspect", { token })).status).toBe(404);
      expect(
        (await passwordSetup("", { token, password: "TakenOver123!x" })).status
      ).toBe(404);
      expect(
        await prisma.userLinkToken.count({
          where: { userId: id, usedAt: null },
        })
      ).toBe(0);
      expect(
        await prisma.passwordChangeGrant.count({ where: { userId: id } })
      ).toBe(0);
      const after = await prisma.user.findUniqueOrThrow({ where: { id } });
      expect(after.passwordHash).toBeNull();
    });
  });
});
