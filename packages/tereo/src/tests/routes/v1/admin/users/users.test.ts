// @module-tag int
// @module-tag auth

import { DEFAULT_ORGANIZATION_ID } from "../../../../../definitions/index.js";
import { getTestPrincipalToken } from "../../../../support/principals.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../utils/db/prisma.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../support/webhooks.js";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createTestUser,
  createAdminUser,
  getAccessTokenForUser,
  generateUniqueId,
} from "../../../../support/auth.js";

interface UserResponse {
  id?: string;
  email?: string;
  name?: string;
  isActive?: boolean;
  password?: string;
  passwordHash?: string;
  [key: string]: unknown;
}

interface UsersListResponse {
  data?: UserResponse[];
  users?: UserResponse[];
  [key: string]: unknown;
}

interface ErrorResponse {
  error?: string;
  error_description?: string;
  message?: string;
  [key: string]: unknown;
}

let regularUser: Awaited<ReturnType<typeof createTestUser>>;
let adminToken: string;
let regularToken: string;

beforeAll(async () => {
  const testClient = await createTestClient();
  const adminUser = await createAdminUser();
  regularUser = await createTestUser();
  adminToken = await getAccessTokenForUser(adminUser, testClient);
  regularToken = await getAccessTokenForUser(regularUser, testClient);
});

describe("GET /v1/admin/users", () => {
  it("should list users with admin token", async () => {
    const response = await fetch(`${BASE_URL}/v1/admin/users`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const data = (await response.json()) as UsersListResponse;

    expect(response.status).toBe(HTTP_STATUS.OK);
    // Response uses "data" key for the array
    expect(Array.isArray(data.data || data.users)).toBe(true);
  });

  it("should return 401 with error for request without auth token", async () => {
    const response = await fetch(`${BASE_URL}/v1/admin/users`);

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });

  it("should return 403 with error for request with non-admin token", async () => {
    const response = await fetch(`${BASE_URL}/v1/admin/users`, {
      headers: { Authorization: `Bearer ${regularToken}` },
    });

    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });

  it("should support cursor pagination", async () => {
    // Ensure at least 3 users exist for a meaningful page break.
    // adminUser, regularUser, and the test client owner should already be there.
    await createTestUser();
    await createTestUser();

    const firstPage = await fetch(`${BASE_URL}/v1/admin/users?limit=2`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(firstPage.status).toBe(HTTP_STATUS.OK);
    const firstData = (await firstPage.json()) as {
      data: Array<{ id: string }>;
      hasMore: boolean;
      limit: number;
      nextCursor: string | null;
    };
    expect(Array.isArray(firstData.data)).toBe(true);
    expect(firstData.data.length).toBeLessThanOrEqual(2);
    expect(typeof firstData.hasMore).toBe("boolean");
    expect(firstData).toHaveProperty("nextCursor");
    expect(firstData.hasMore).toBe(true);

    expect(firstData.nextCursor).toBeTruthy();
    const secondPage = await fetch(
      `${BASE_URL}/v1/admin/users?limit=2&cursor=${encodeURIComponent(
        firstData.nextCursor as string
      )}`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    expect(secondPage.status).toBe(HTTP_STATUS.OK);
    const secondData = (await secondPage.json()) as {
      data: Array<{ id: string }>;
    };

    // No overlap between pages
    const firstIds = new Set(firstData.data.map((u) => u.id));
    for (const u of secondData.data) {
      expect(firstIds.has(u.id)).toBe(false);
    }
  });

  it("should return 400 for tampered cursor", async () => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/users?limit=10&cursor=not-a-real-cursor`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBe("invalid_cursor");
  });

  describe("sorted by name, some names null", () => {
    const tag = `nullsort-${generateUniqueId()}`.toLowerCase();
    let named: string[];
    let unnamed: string[];

    beforeAll(async () => {
      const make = (name: string | null, i: number) =>
        prisma.user.create({
          data: {
            email: `${tag}-${i}@test.local`,
            passwordHash: "x",
            name,
          },
        });
      const users = await Promise.all(
        ["Carol", null, "Alice", null, "Bob"].map(make)
      );
      named = users
        .filter((u) => u.name !== null)
        .sort((a, b) => a.name!.localeCompare(b.name!))
        .map((u) => u.id);
      unnamed = users
        .filter((u) => u.name === null)
        .map((u) => u.id)
        .sort();
    });

    afterAll(async () => {
      await prisma.user.deleteMany({
        where: { email: { startsWith: tag } },
      });
    });

    // One row per page, so every page boundary — including the ones
    // landing on a NULL — goes through the cursor.
    const pageThrough = async (sortDir: "asc" | "desc") => {
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const params = new URLSearchParams({
          sort: "name",
          sortDir,
          limit: "1",
          "filter[email]": tag,
          "filter[email_op]": "contains",
        });
        if (cursor) params.set("cursor", cursor);
        const response = await fetch(`${BASE_URL}/v1/admin/users?${params}`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        });
        expect(response.status).toBe(HTTP_STATUS.OK);
        const page = (await response.json()) as {
          data: Array<{ id: string }>;
          nextCursor: string | null;
        };
        ids.push(...page.data.map((u) => u.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      return ids;
    };

    it("pages ascending through the names, then the NULLs", async () => {
      expect(await pageThrough("asc")).toEqual([...named, ...unnamed]);
    });

    it("pages descending through the NULLs, then the names", async () => {
      expect(await pageThrough("desc")).toEqual([
        ...unnamed,
        ...[...named].reverse(),
      ]);
    });
  });
});

describe("POST /v1/admin/users", () => {
  it("should create a new user", async () => {
    const uniqueId = generateUniqueId();
    const newUserData = {
      email: `new-user-${uniqueId}@test.local`,
      password: "NewPassword123!",
      name: `New User ${uniqueId}`,
      userType: "human" as const,
    };

    const response = await fetch(`${BASE_URL}/v1/admin/users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(newUserData),
    });

    const data = (await response.json()) as UserResponse;

    expect(response.status).toBe(HTTP_STATUS.CREATED);
    expect(data.email).toBe(newUserData.email);
    expect(data.name).toBe(newUserData.name);
    expect(data.password).toBeUndefined(); // Should not return password
    expect(data.passwordHash).toBeUndefined(); // Should not return hash
  });

  it("should return 409 conflict for duplicate email", async () => {
    const response = await fetch(`${BASE_URL}/v1/admin/users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: regularUser.email,
        password: "Password123!@#",
        name: "Duplicate User",
        userType: "human",
      }),
    });

    expect(response.status).toBe(HTTP_STATUS.CONFLICT);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });

  const postUser = (token: string, body: Record<string, unknown>) =>
    fetch(`${BASE_URL}/v1/admin/users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

  it("stores the email trimmed and lower-cased, and defaults userType to human", async () => {
    const writer = await getTestPrincipalToken({
      permissions: ["users.write"],
    });
    const uniqueId = generateUniqueId();
    const response = await postUser(writer, {
      email: `  Mixed.Case-${uniqueId}@Test.LOCAL `,
      password: "Password123!@#",
    });
    expect(response.status).toBe(HTTP_STATUS.CREATED);
    const data = (await response.json()) as UserResponse;
    expect(data.email).toBe(`mixed.case-${uniqueId}@test.local`);
    expect(data.userType).toBe("human");
  });

  it("returns 409 for an email differing from an existing one only by case", async () => {
    const writer = await getTestPrincipalToken({
      permissions: ["users.write"],
    });
    const response = await postUser(writer, {
      email: regularUser.email.toUpperCase(),
      password: "Password123!@#",
      userType: "human",
    });
    expect(response.status).toBe(HTTP_STATUS.CONFLICT);
  });

  it("returns 400 for userType service_account", async () => {
    const writer = await getTestPrincipalToken({
      permissions: ["users.write"],
    });
    const email = `svc-${generateUniqueId()}@test.local`;
    const response = await postUser(writer, {
      email,
      password: "Password123!@#",
      userType: "service_account",
    });
    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("should return 400 with error for invalid email format", async () => {
    const response = await fetch(`${BASE_URL}/v1/admin/users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: "invalid-email",
        password: "Password123!",
        name: "Invalid User",
      }),
    });

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });

  it("should return 403 with error for request from non-admin", async () => {
    const response = await fetch(`${BASE_URL}/v1/admin/users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${regularToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: "test@example.com",
        password: "Password123!",
        name: "Test User",
      }),
    });

    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBeDefined();
  });
});

describe("POST /v1/admin/users events", () => {
  it("audits the new user and emits auth.user.created", async () => {
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["auth.user.created"] }
    );
    const email = `created-${generateUniqueId()}@example.com`;
    const response = await fetch(`${BASE_URL}/v1/admin/users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        password: "Str0ng-Passw0rd!x",
        userType: "human",
      }),
    });
    expect(response.status).toBe(HTTP_STATUS.CREATED);
    const created = (await response.json()) as UserResponse;

    const where = {
      webhookEndpointId: endpoint.id,
      eventType: "auth.user.created",
      payload: { path: ["entityId"], equals: created.id },
    };
    await waitFor(
      async () => (await prisma.webhookDelivery.count({ where })) > 0,
      10_000
    );
  });
});
