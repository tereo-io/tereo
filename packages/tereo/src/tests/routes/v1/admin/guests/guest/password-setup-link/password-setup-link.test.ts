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

let adminToken: string;
let orgId: string;

beforeAll(async () => {
  adminToken = await getAccessTokenForUser(
    await createAdminUser(),
    await createTestClient()
  );
  orgId = await ensureTestOrganization("admin-guest-link");
});

const issue = (id: string, body?: unknown) =>
  fetchJson(
    "POST",
    `${BASE_URL}/v1/admin/guests/${id}/password-setup-link`,
    adminToken,
    body
  );

describe("POST /v1/admin/guests/:id/password-setup-link", () => {
  it("issues a fresh link, and the earlier one dies", async () => {
    const { user } = await createTestGuest({ organizationId: orgId });

    const first = await issue(user.id);
    const second = await issue(user.id, { notify: false });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.url).toMatch(/\/set-password#token=/);
    expect(second.body.url).not.toBe(first.body.url);
    expect(new Date(second.body.expiresAt).getTime()).toBeGreaterThan(
      Date.now()
    );
    expect(
      await prisma.userLinkToken.count({
        where: { userId: user.id, usedAt: null },
      })
    ).toBe(1);
  });

  it.each([
    ["deactivated", { isActive: false }],
    ["expired", { expiresAt: new Date(Date.now() - 1000) }],
  ])("refuses a %s guest with 409 guest_not_usable", async (_label, data) => {
    const { user } = await createTestGuest({ organizationId: orgId });
    await prisma.user.update({ where: { id: user.id }, data });

    const res = await issue(user.id);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("guest_not_usable");
    expect(
      await prisma.userLinkToken.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("returns 404 not_a_guest for a regular user", async () => {
    const human = await createTestUser();
    const res = await issue(human.id);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_a_guest");
  });
});

describe("password-setup-link outside the caller's organizations", () => {
  it("is refused, issuing no link", async () => {
    const { user } = await createTestGuest({ organizationId: orgId });
    const token = await getTestPrincipalToken({
      organizationId: orgId,
      permissions: ["users.guests.write"],
    });
    const res = await fetchJson(
      "POST",
      `${BASE_URL}/v1/admin/guests/${user.id}/password-setup-link`,
      token
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_a_guest");
    expect(
      await prisma.userLinkToken.count({ where: { userId: user.id } })
    ).toBe(0);
  });
});

describe("password-setup-link for a guest who has a password", () => {
  // A member of the guest's organization, holding `permissions` globally.
  const memberToken = async (permissions: string[]) => {
    const userId = randomUUID();
    const token = await getTestPrincipalToken({ userId, permissions });
    await prisma.organizationMember.create({
      data: { organizationId: orgId, userId, memberRole: "member" },
    });
    return token;
  };
  const issueAs = (token: string, id: string) =>
    fetchJson(
      "POST",
      `${BASE_URL}/v1/admin/guests/${id}/password-setup-link`,
      token
    );

  it("is refused with 403 guest_has_password to users.guests.write alone", async () => {
    const { user } = await createTestGuest({ organizationId: orgId });

    const res = await issueAs(
      await memberToken(["users.guests.write"]),
      user.id
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("guest_has_password");
    expect(res.body.url).toBeUndefined();
    expect(
      await prisma.userLinkToken.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("is issued to a caller who may reset the guest's credentials", async () => {
    const { user } = await createTestGuest({ organizationId: orgId });

    const res = await issueAs(
      await memberToken(["users.guests.write", "users.write"]),
      user.id
    );

    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/\/set-password#token=/);
  });

  it("is refused to users.write lacking a permission the guest holds", async () => {
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
    const { user } = await createTestGuest({
      organizationId: orgId,
      roleIds: [role.id],
    });

    const res = await issueAs(
      await memberToken(["users.guests.write", "users.write"]),
      user.id
    );

    expect(res.status).toBe(403);
    expect(
      await prisma.userLinkToken.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("stays open to users.guests.write while the guest has no password", async () => {
    const { user } = await createTestGuest({ organizationId: orgId });
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: null },
    });

    const res = await issueAs(
      await memberToken(["users.guests.write"]),
      user.id
    );

    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/\/set-password#token=/);
  });
});
