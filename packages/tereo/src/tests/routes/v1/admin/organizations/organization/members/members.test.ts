// @module-tag int
// @module-tag auth

import { getAccessTokenForUser } from "../../../../../../support/auth/login.js";
import { createTestClient } from "../../../../../../support/auth/clients.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createTestOrganization,
  addTestOrgMember,
  type OrganizationMembersResponse,
  type OrganizationMemberResponse,
} from "../../../../../../support/auth/organizations.js";
import {
  BASE_URL,
  HTTP_STATUS,
  NON_EXISTENT_UUID,
} from "../../../../../../support/auth/constants.js";
import {
  createTestUser,
  createAdminUser,
} from "../../../../../../support/auth/users.js";

let adminUser: Awaited<ReturnType<typeof createAdminUser>>;
let adminToken: string;

beforeAll(async () => {
  const testClient = await createTestClient();
  adminUser = await createAdminUser();
  adminToken = await getAccessTokenForUser(adminUser, testClient);
});

describe("POST /v1/admin/organizations/:id/members", () => {
  it("should add a member with default role", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId: user.id }),
      }
    );

    const data = (await response.json()) as OrganizationMemberResponse;
    expect(response.status).toBe(HTTP_STATUS.CREATED);
    expect(data.memberRole).toBe("member");
    expect(data.user.id).toBe(user.id);

    const entry = await prisma.auditLogEntry.findFirst({
      where: { entityType: "OrganizationMember", entityId: data.id },
    });
    expect(entry).toMatchObject({
      action: "CREATE",
      organizationId: org.id,
      userId: adminUser.id,
      entityName: user.email,
      metadata: { userId: user.id, memberRole: "member" },
    });
  });

  it("should return 400 unknown_user for a userId that names no user", async () => {
    const org = await createTestOrganization(adminToken);

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId: randomUUID() }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    const data = (await response.json()) as { error: string };
    expect(data.error).toBe("unknown_user");
  });

  it("should add a member with owner role", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId: user.id, memberRole: "owner" }),
      }
    );

    const data = (await response.json()) as OrganizationMemberResponse;
    expect(response.status).toBe(HTTP_STATUS.CREATED);
    expect(data.memberRole).toBe("owner");
  });

  it("should return 409 when user is already a member", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    await addTestOrgMember(adminToken, org.id, user.id);

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId: user.id }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.CONFLICT);
  });

  it("should return 404 for non-existent organization", async () => {
    const user = await createTestUser();

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${NON_EXISTENT_UUID}/members`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId: user.id }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it("should return 400 for invalid memberRole", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId: user.id, memberRole: "superadmin" }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    const error = (await response.json()) as {
      error?: string;
      error_description?: string;
    };
    expect(error.error).toBe("invalid_request");
    expect(error.error_description).toMatch(
      /^Invalid request body\. memberRole: /
    );
  });
});

describe("GET /v1/admin/organizations/:id/members", () => {
  it("should list members of an organization", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    await addTestOrgMember(adminToken, org.id, user.id);

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    const data = (await response.json()) as OrganizationMembersResponse;
    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.organizationId).toBe(org.id);
    expect(Array.isArray(data.members)).toBe(true);
    expect(data.members.length).toBeGreaterThanOrEqual(1);
  });

  it("should return 404 for non-existent organization", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${NON_EXISTENT_UUID}/members`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });
});
