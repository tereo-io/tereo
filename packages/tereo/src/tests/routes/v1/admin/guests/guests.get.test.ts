// @module-tag int
// @module-tag auth
import { getAccessTokenForUser } from "../../../../support/auth/login.js";
import { createTestClient } from "../../../../support/auth/clients.js";
import { createTestGuest } from "../../../../support/auth/guests.js";
import { createAdminUser } from "../../../../support/auth/users.js";
import { BASE_URL } from "../../../../support/auth/constants.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import { fetchJson } from "../../../../support/http.js";
import { randomUUID } from "node:crypto";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../../support/principals.js";

let adminToken: string;
let orgId: string;
let otherOrgId: string;

beforeAll(async () => {
  const client = await createTestClient();
  adminToken = await getAccessTokenForUser(await createAdminUser(), client);
  orgId = await ensureTestOrganization("guests-invite");
  otherOrgId = await ensureTestOrganization("guests-invite-other");
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
    for (const user of res.body.data) {
      expect(user.userType).toBe("guest");
      expect(user.status).toBe("active");
    }
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
