// @module-tag int
// @module-tag auth

import { getAccessTokenForUser } from "../../../../../../../support/auth/login.js";
import { createTestClient } from "../../../../../../../support/auth/clients.js";
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  createTestOrganization,
  addTestOrgMember,
} from "../../../../../../../support/auth/organizations.js";
import {
  BASE_URL,
  HTTP_STATUS,
} from "../../../../../../../support/auth/constants.js";
import {
  createTestUser,
  createAdminUser,
} from "../../../../../../../support/auth/users.js";

let testClient: Awaited<ReturnType<typeof createTestClient>>;
let adminToken: string;
let regularToken: string;

beforeAll(async () => {
  testClient = await createTestClient();
  const adminUser = await createAdminUser();
  const regularUser = await createTestUser();
  adminToken = await getAccessTokenForUser(adminUser, testClient);
  regularToken = await getAccessTokenForUser(regularUser, testClient);
});

describe("PATCH /v1/admin/organizations/:id/members/:userId", () => {
  it("should return 403 when caller is neither platform admin nor org member", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    await addTestOrgMember(adminToken, org.id, user.id);

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${regularToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ memberRole: "admin" }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("should return 403 when an org admin tries to change an owner's role", async () => {
    const org = await createTestOrganization(adminToken);
    const owner = await createTestUser();
    const orgAdmin = await createTestUser();
    await addTestOrgMember(adminToken, org.id, owner.id, "owner");
    await addTestOrgMember(adminToken, org.id, orgAdmin.id, "admin");
    const orgAdminToken = await getAccessTokenForUser(orgAdmin, testClient);

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${owner.id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${orgAdminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ memberRole: "member" }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("should return 403 when an org admin tries to make anyone an owner, themselves included", async () => {
    const org = await createTestOrganization(adminToken);
    const member = await createTestUser();
    const orgAdmin = await createTestUser();
    await addTestOrgMember(adminToken, org.id, member.id);
    await addTestOrgMember(adminToken, org.id, orgAdmin.id, "admin");
    const orgAdminToken = await getAccessTokenForUser(orgAdmin, testClient);

    for (const target of [member.id, orgAdmin.id]) {
      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${target}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${orgAdminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ memberRole: "owner" }),
        }
      );
      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    }

    const added = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${orgAdminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          userId: (await createTestUser()).id,
          memberRole: "owner",
        }),
      }
    );
    expect(added.status).toBe(HTTP_STATUS.FORBIDDEN);

    const roles = await prisma.organizationMember.findMany({
      where: { organizationId: org.id },
      select: { memberRole: true },
    });
    expect(roles.map((r) => r.memberRole).sort()).toEqual(["admin", "member"]);
  });
});

describe("DELETE /v1/admin/organizations/:id/members/:userId", () => {
  it("should return 401 without authentication", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    await addTestOrgMember(adminToken, org.id, user.id);

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}`,
      { method: "DELETE" }
    );

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });

  it("should return 403 when caller is neither platform admin nor org member", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    await addTestOrgMember(adminToken, org.id, user.id);

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${regularToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("should return 403 when caller is only an org member", async () => {
    const org = await createTestOrganization(adminToken);
    const target = await createTestUser();
    const plainMember = await createTestUser();
    await addTestOrgMember(adminToken, org.id, target.id);
    await addTestOrgMember(adminToken, org.id, plainMember.id, "member");
    const memberToken = await getAccessTokenForUser(plainMember, testClient);

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${target.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${memberToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("should return 403 when an org admin tries to remove an owner", async () => {
    const org = await createTestOrganization(adminToken);
    const owner = await createTestUser();
    const orgAdmin = await createTestUser();
    await addTestOrgMember(adminToken, org.id, owner.id, "owner");
    await addTestOrgMember(adminToken, org.id, orgAdmin.id, "admin");
    const orgAdminToken = await getAccessTokenForUser(orgAdmin, testClient);

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${owner.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${orgAdminToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
  });
});
