// @module-tag int
// @module-tag auth

import { DEFAULT_ORGANIZATION_ID } from "../../../../../../../../definitions/index.js";
import { getAccessTokenForUser } from "../../../../../../../support/auth/login.js";
import { createTestClient } from "../../../../../../../support/auth/clients.js";
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  createTestOrganization,
  addTestOrgMember,
  type OrganizationMemberResponse,
} from "../../../../../../../support/auth/organizations.js";
import {
  BASE_URL,
  HTTP_STATUS,
} from "../../../../../../../support/auth/constants.js";
import {
  createTestUser,
  createAdminUser,
  createTestRole,
} from "../../../../../../../support/auth/users.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../../../../support/webhooks.js";

let testClient: Awaited<ReturnType<typeof createTestClient>>;
let adminUser: Awaited<ReturnType<typeof createAdminUser>>;
let adminToken: string;

beforeAll(async () => {
  testClient = await createTestClient();
  adminUser = await createAdminUser();
  adminToken = await getAccessTokenForUser(adminUser, testClient);
});

describe("PATCH /v1/admin/organizations/:id/members/:userId", () => {
  it("should update member role", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    await addTestOrgMember(adminToken, org.id, user.id, "member");

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ memberRole: "admin" }),
      }
    );

    const data = (await response.json()) as OrganizationMemberResponse;
    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(data.memberRole).toBe("admin");

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        entityType: "OrganizationMember",
        entityId: data.id,
        action: "UPDATE",
      },
    });
    expect(entry).toMatchObject({
      organizationId: org.id,
      userId: adminUser.id,
      changes: { memberRole: { old: "member", new: "admin" } },
      metadata: { userId: user.id },
    });
  });

  it("should return 404 when user is not a member", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ memberRole: "admin" }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it("should return 400 for invalid memberRole", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    await addTestOrgMember(adminToken, org.id, user.id);

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ memberRole: "invalid" }),
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

  it("should return 409 when demoting the last owner", async () => {
    const org = await createTestOrganization(adminToken);
    const owner = await createTestUser();
    await addTestOrgMember(adminToken, org.id, owner.id, "owner");

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${owner.id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ memberRole: "admin" }),
      }
    );
    expect(response.status).toBe(HTTP_STATUS.CONFLICT);
  });

  it("emits auth.organization.member-updated", async () => {
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["auth.organization.member-updated"] }
    );
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    const member = await addTestOrgMember(adminToken, org.id, user.id);

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ memberRole: "admin" }),
      }
    );
    expect(response.status).toBe(HTTP_STATUS.OK);

    const where = {
      webhookEndpointId: endpoint.id,
      eventType: "auth.organization.member-updated",
      payload: { path: ["entityId"], equals: member.id },
    };
    await waitFor(
      async () => (await prisma.webhookDelivery.count({ where })) > 0,
      10_000
    );
  });
});

describe("DELETE /v1/admin/organizations/:id/members/:userId", () => {
  it("should remove a member", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    const member = await addTestOrgMember(adminToken, org.id, user.id);

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        entityType: "OrganizationMember",
        entityId: member.id,
        action: "DELETE",
      },
    });
    expect(entry).toMatchObject({
      organizationId: org.id,
      userId: adminUser.id,
      entityName: user.email,
      metadata: { userId: user.id, memberRole: "member" },
    });
  });

  it("should return 404 when user is not a member", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it("should return 409 when removing the last owner", async () => {
    const org = await createTestOrganization(adminToken);
    const owner = await createTestUser();
    await addTestOrgMember(adminToken, org.id, owner.id, "owner");

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${owner.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    expect(response.status).toBe(HTTP_STATUS.CONFLICT);
    expect(
      await prisma.organizationMember.count({
        where: { organizationId: org.id, userId: owner.id },
      })
    ).toBe(1);
  });

  it("drops the member's org-scoped roles with the membership", async () => {
    const org = await createTestOrganization(adminToken);
    const user = await createTestUser();
    await addTestOrgMember(adminToken, org.id, user.id);
    const role = await createTestRole();
    const put = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ roleIds: [role.id] }),
      }
    );
    expect(put.status).toBe(HTTP_STATUS.OK);

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);
    expect(
      await prisma.userRole.count({
        where: { userId: user.id, organizationId: org.id },
      })
    ).toBe(0);
  });

  it("should allow an org admin without platform permissions to remove a member", async () => {
    const org = await createTestOrganization(adminToken);
    const target = await createTestUser();
    const orgAdmin = await createTestUser();
    await addTestOrgMember(adminToken, org.id, target.id);
    await addTestOrgMember(adminToken, org.id, orgAdmin.id, "admin");
    const orgAdminToken = await getAccessTokenForUser(orgAdmin, testClient);

    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations/${org.id}/members/${target.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${orgAdminToken}` },
      }
    );

    expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);
  });
});
