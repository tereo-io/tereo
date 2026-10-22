// @module-tag int
// @module-tag auth

import { prisma } from "../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createAdminUser,
  getAccessTokenForUser,
  generateUniqueId,
  createTestOrganization,
  type OrganizationResponse,
  type OrganizationListResponse,
} from "../../../../support/auth.js";

let adminToken: string;

beforeAll(async () => {
  const testClient = await createTestClient();
  const adminUser = await createAdminUser();
  adminToken = await getAccessTokenForUser(adminUser, testClient);
});

describe("POST /v1/admin/organizations", () => {
  it("should create an organization", async () => {
    const uniqueId = generateUniqueId();
    const response = await fetch(`${BASE_URL}/v1/admin/organizations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `Test Org ${uniqueId}`,
        slug: `test-org-${uniqueId}`,
        code: uniqueId.slice(0, 6).toUpperCase(),
      }),
    });

    const data = (await response.json()) as OrganizationResponse;
    expect(response.status).toBe(HTTP_STATUS.CREATED);
    expect(data.id).toBeDefined();
    expect(data.name).toBe(`Test Org ${uniqueId}`);
    expect(data.slug).toBe(`test-org-${uniqueId}`);
    expect(data.isActive).toBe(true);
    expect(data.isDefault).toBe(false);
    expect(data.memberCount).toBe(0);
  });

  it("should return 409 for duplicate slug", async () => {
    const org = await createTestOrganization(adminToken);

    const response = await fetch(`${BASE_URL}/v1/admin/organizations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Different Name",
        slug: org.slug,
        code: generateUniqueId().slice(0, 6).toUpperCase(),
      }),
    });

    const data = (await response.json()) as { error?: string };
    expect(response.status).toBe(HTTP_STATUS.CONFLICT);
    expect(data.error).toBe("slug_taken");
  });

  it("should return 409 for duplicate code", async () => {
    const code = generateUniqueId().slice(0, 6).toUpperCase();
    await createTestOrganization(adminToken, { code });

    const response = await fetch(`${BASE_URL}/v1/admin/organizations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Different Name",
        slug: `test-org-${generateUniqueId()}`,
        code,
      }),
    });

    const data = (await response.json()) as { error?: string };
    expect(response.status).toBe(HTTP_STATUS.CONFLICT);
    expect(data.error).toBe("code_taken");
  });

  it("should return 400 for invalid slug format", async () => {
    const response = await fetch(`${BASE_URL}/v1/admin/organizations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Test",
        slug: "INVALID_SLUG!",
        code: "ABC",
      }),
    });

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    const error = (await response.json()) as {
      error?: string;
      error_description?: string;
    };
    expect(error.error).toBe("invalid_request");
    expect(error.error_description).toMatch(/^Invalid request body\. slug: /);
  });
});

describe("GET /v1/admin/organizations", () => {
  it("should list organizations with admin token", async () => {
    const response = await fetch(`${BASE_URL}/v1/admin/organizations`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const data = (await response.json()) as OrganizationListResponse;
    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(Array.isArray(data.data)).toBe(true);
    expect(typeof data.hasMore).toBe("boolean");
    expect(typeof data.limit).toBe("number");
    expect(data).toHaveProperty("nextCursor");
  });

  it("filters by isActive", async () => {
    const active = await createTestOrganization(adminToken);
    const inactive = await createTestOrganization(adminToken);
    await prisma.organization.update({
      where: { id: inactive.id },
      data: { isActive: false },
    });

    const list = async (slug: string, isActive: string) => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/organizations?filter[isActive]=${isActive}` +
          `&filter[slug]=${slug}&filter[slug_op]=equals`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      expect(response.status).toBe(HTTP_STATUS.OK);
      const data = (await response.json()) as OrganizationListResponse;
      return data.data.map((o) => o.id);
    };

    expect(await list(active.slug, "true")).toEqual([active.id]);
    expect(await list(active.slug, "false")).toEqual([]);
    expect(await list(inactive.slug, "false")).toEqual([inactive.id]);
    expect(await list(inactive.slug, "true")).toEqual([]);
  });

  it("should support cursor pagination", async () => {
    // Ensure at least 3 orgs exist for a meaningful page break
    await createTestOrganization(adminToken);
    await createTestOrganization(adminToken);
    await createTestOrganization(adminToken);

    const firstPage = await fetch(
      `${BASE_URL}/v1/admin/organizations?limit=2`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    const firstData = (await firstPage.json()) as OrganizationListResponse;
    expect(firstPage.status).toBe(HTTP_STATUS.OK);
    expect(firstData.data.length).toBe(2);
    expect(firstData.hasMore).toBe(true);
    expect(firstData.nextCursor).toBeTruthy();

    const secondPage = await fetch(
      `${BASE_URL}/v1/admin/organizations?limit=2&cursor=${encodeURIComponent(
        firstData.nextCursor as string
      )}`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    const secondData = (await secondPage.json()) as OrganizationListResponse;
    expect(secondPage.status).toBe(HTTP_STATUS.OK);
    expect(secondData.data.length).toBeGreaterThan(0);

    // No overlap between pages
    const firstIds = new Set(firstData.data.map((o) => o.id));
    for (const o of secondData.data) {
      expect(firstIds.has(o.id)).toBe(false);
    }
  });

  it("should return 400 for tampered cursor", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/organizations?limit=2&cursor=not-a-real-cursor`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    const data = (await response.json()) as { error?: string };
    expect(data.error).toBe("invalid_cursor");
  });
});
