// @module-tag int
// @module-tag auth
import { ensureTestOrganization } from "../../../../../../support/principals.js";
import { getAccessTokenForUser } from "../../../../../../support/auth/login.js";
import { createTestClient } from "../../../../../../support/auth/clients.js";
import { createTestGuest } from "../../../../../../support/auth/guests.js";
import { BASE_URL } from "../../../../../../support/auth/constants.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../../support/http.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  createAdminUser,
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
      await prisma.passwordSetupToken.count({
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
      await prisma.passwordSetupToken.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("returns 404 not_a_guest for a regular user", async () => {
    const human = await createTestUser();
    const res = await issue(human.id);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_a_guest");
  });
});
