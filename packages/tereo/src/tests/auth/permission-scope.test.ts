import { ensurePermission, makeServiceOf } from "../utils/testService.js";
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
} from "./utils/test-helpers.js";
import {
  ensureTestMembership,
  ensureTestOrganization,
  ensureTestUser,
  getTestPrincipalToken,
} from "../utils/principals.js";

/**
 * A role held in an organization counts only where that organization is
 * named: never for a token, check or profile that names none.
 */
describe("Org-scoped roles without an organization", () => {
  const userId = randomUUID();
  let orgId: string;
  let orglessToken: string;
  let orgToken: string;

  beforeAll(async () => {
    await ensureTestUser(userId);
    orgId = await ensureTestOrganization(`perm-scope-${userId}`);
    const permission = await ensurePermission("webhooks.read");
    const role = await prisma.role.create({
      data: {
        name: `org-scoped-${userId}`,
        displayName: "Org-scoped webhooks.read",
        rolePermissions: { create: [{ permissionId: permission.id }] },
      },
    });
    await prisma.userRole.create({
      data: { userId, roleId: role.id, organizationId: orgId },
    });

    orglessToken = await getTestPrincipalToken({
      userId,
      organizationId: null,
      permissions: [],
    });
    orgToken = await getTestPrincipalToken({
      userId,
      organizationId: orgId,
      permissions: [],
    });
  });

  it("an org-less token does not carry the org role's permissions", async () => {
    const response = await fetch(`${BASE_URL}/v1/webhooks/webhooks`, {
      headers: { Authorization: `Bearer ${orglessToken}` },
    });
    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);

    const me = await fetch(`${BASE_URL}/v1/account/me`, {
      headers: { Authorization: `Bearer ${orglessToken}` },
    });
    expect(me.status).toBe(HTTP_STATUS.OK);
    const profile = (await me.json()) as { permissions: string[] };
    expect(profile.permissions).not.toContain("webhooks.read");
  });

  it("a token for that organization does", async () => {
    const response = await fetch(`${BASE_URL}/v1/webhooks/webhooks`, {
      headers: { Authorization: `Bearer ${orgToken}` },
    });
    expect(response.status).toBe(HTTP_STATUS.OK);

    const me = await fetch(`${BASE_URL}/v1/account/me`, {
      headers: { Authorization: `Bearer ${orgToken}` },
    });
    const profile = (await me.json()) as { permissions: string[] };
    expect(profile.permissions).toContain("webhooks.read");
  });

  it("the admin view of the user's permissions lists only global ones", async () => {
    const admin = await getTestPrincipalToken({ permissions: ["users.read"] });
    const response = await fetch(
      `${BASE_URL}/v1/admin/users/${userId}/permissions`,
      { headers: { Authorization: `Bearer ${admin}` } }
    );
    expect(response.status).toBe(HTTP_STATUS.OK);
    const body = (await response.json()) as { permissions: string[] };
    expect(body.permissions).not.toContain("webhooks.read");
  });

  it("check-permission counts the org role only for a client of the organization", async () => {
    const check = async (organizationId: string | null) => {
      const client = await createTestClient({ clientType: "confidential" });
      if (organizationId) {
        await prisma.oAuthClient.update({
          where: { id: client.id },
          data: { organizationId },
        });
      } else {
        // A client of no organization is answered only if it is a service's.
        await makeServiceOf(client.id);
      }
      const response = await fetch(`${BASE_URL}/oauth/check-permission`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${client.clientId}:${client.plainSecret}`
          ).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ user_id: userId, permission: "webhooks.read" }),
      });
      expect(response.status).toBe(HTTP_STATUS.OK);
      return ((await response.json()) as { granted: boolean }).granted;
    };

    await ensureTestMembership(userId, orgId);
    expect(await check(null)).toBe(false);
    expect(await check(orgId)).toBe(true);
  });
});
