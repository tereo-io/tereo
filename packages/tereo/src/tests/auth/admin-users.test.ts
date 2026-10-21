import { encryptTotpSecret, generateTotpSecret } from "../../utils/totp.js";
import { startFakeOidcProvider } from "../utils/fakeOidcProvider.js";
import type { FakeOidcProvider } from "../utils/fakeOidcProvider.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestPrincipalToken } from "../utils/principals.js";
import { upstreamLogin } from "../utils/upstreamLogin.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "node:crypto";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../webhooks/utils/test-helpers.js";
import {
  DEFAULT_ORGANIZATION_ID,
  SYSTEM_USER_ID,
} from "../../definitions/index.js";
import {
  BASE_URL,
  HTTP_STATUS,
  NON_EXISTENT_UUID,
  createTestClient,
  createTestUser,
  createAdminUser,
  createTestRole,
  getAccessTokenForUser,
  generateUniqueId,
  createTestOrganization,
  addTestOrgMember,
} from "./utils/test-helpers.js";

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

interface PermissionsListResponse {
  userId: string;
  permissions: string[];
}

interface UserRolesResponse {
  userId: string;
  roles: Array<{
    id: string;
    name: string;
    displayName: string;
    expiresAt: string | null;
  }>;
}

interface UserSessionsResponse {
  userId: string;
  sessions: Array<{
    id: string;
    clientId: string;
    clientName: string;
    scopes: string[];
    createdAt: string;
    expiresAt: string;
    isCurrent: boolean;
  }>;
}

interface RevokeAllSessionsResponse {
  revokedCount: number;
  currentSessionRevoked: boolean;
}

interface ErrorResponse {
  error?: string;
  error_description?: string;
  message?: string;
  [key: string]: unknown;
}

describe("Admin Users Endpoints", () => {
  let testClient: Awaited<ReturnType<typeof createTestClient>>;
  let adminUser: Awaited<ReturnType<typeof createAdminUser>>;
  let regularUser: Awaited<ReturnType<typeof createTestUser>>;
  let adminToken: string;
  let regularToken: string;

  beforeAll(async () => {
    testClient = await createTestClient();
    adminUser = await createAdminUser();
    regularUser = await createTestUser();

    adminToken = await getAccessTokenForUser(adminUser, testClient);
    regularToken = await getAccessTokenForUser(regularUser, testClient);
  });

  describe("GET /admin/users", () => {
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

  describe("POST /admin/users", () => {
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

  describe("GET /admin/users/:id", () => {
    it("should get user by ID", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${regularUser.id}`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      const data = (await response.json()) as UserResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.id).toBe(regularUser.id);
      expect(data.email).toBe(regularUser.email);
    });

    it("should return 404 for non-existent user", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${NON_EXISTENT_UUID}`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("should reject request from non-admin", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${regularUser.id}`,
        {
          headers: { Authorization: `Bearer ${regularToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    });
  });

  describe("PATCH /admin/users/:id", () => {
    it("should update user", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${regularUser.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "Updated Name" }),
        }
      );

      const data = (await response.json()) as UserResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.name).toBe("Updated Name");
    });

    it("lower-cases a new email and refuses one taken in another case", async () => {
      const writer = await getTestPrincipalToken({
        permissions: ["users.write"],
      });
      const target = await createTestUser();
      const patch = (email: string) =>
        fetch(`${BASE_URL}/v1/admin/users/${target.id}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${writer}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email }),
        });

      const taken = await patch(regularUser.email.toUpperCase());
      expect(taken.status).toBe(HTTP_STATUS.CONFLICT);

      const renamed = `Renamed-${generateUniqueId()}@Test.Local`;
      const response = await patch(renamed);
      expect(response.status).toBe(HTTP_STATUS.OK);
      const data = (await response.json()) as UserResponse;
      expect(data.email).toBe(renamed.toLowerCase());
    });

    it("should update user active status", async () => {
      const target = await createTestUser();
      const response = await fetch(`${BASE_URL}/v1/admin/users/${target.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ isActive: false }),
      });

      const data = (await response.json()) as UserResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.isActive).toBe(false);

      // Restore active status
      await fetch(`${BASE_URL}/v1/admin/users/${target.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ isActive: true }),
      });
    });

    it("should return 404 for non-existent user", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${NON_EXISTENT_UUID}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "Test" }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    const patch = (id: string, body: unknown, token = adminToken) =>
      fetch(`${BASE_URL}/v1/admin/users/${id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

    it("refuses to let an admin deactivate their own account", async () => {
      const response = await patch(adminUser.id, { isActive: false });
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBe("self_deactivation");

      const row = await prisma.user.findUniqueOrThrow({
        where: { id: adminUser.id },
      });
      expect(row.isActive).toBe(true);
    });

    it("keeps password hashes out of the audit entry", async () => {
      const target = await createTestUser();
      const response = await patch(target.id, {
        name: "Renamed",
        password: "An0ther-Str0ng-Passw0rd!",
      });
      expect(response.status).toBe(HTTP_STATUS.OK);

      const entry = await prisma.auditLogEntry.findFirstOrThrow({
        where: { entityId: target.id, entityType: "User", action: "UPDATE" },
        orderBy: { createdAt: "desc" },
      });
      expect(JSON.stringify(entry.changes)).not.toContain("passwordHash");
      expect(JSON.stringify(entry.changes)).not.toContain("$argon2");
      expect(entry.changes).toMatchObject({
        name: { new: "Renamed" },
      });
      expect(entry.metadata).toMatchObject({ passwordReset: true });
    });

    it("does not let a user be bound to an OAuth client", async () => {
      const target = await createTestUser();
      const response = await patch(target.id, {
        oauthClientId: testClient.id,
      });
      expect(response.status).toBe(HTTP_STATUS.OK);

      const row = await prisma.user.findUniqueOrThrow({
        where: { id: target.id },
      });
      expect(row.oauthClientId).toBeNull();
    });

    it("refuses a service's account, which /admin/services manages", async () => {
      const created = await fetch(`${BASE_URL}/v1/admin/services`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: `svcuser${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        }),
      });
      expect(created.status).toBe(HTTP_STATUS.CREATED);
      const { id } = (await created.json()) as { id: string };
      const service = await prisma.service.findUniqueOrThrow({
        where: { id },
        include: { client: { include: { serviceAccountUser: true } } },
      });
      const accountId = service.client!.serviceAccountUser!.id;

      const response = await patch(accountId, { isActive: false });
      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: accountId },
      });
      expect(row.isActive).toBe(true);
    });
  });

  describe("POST /admin/users events", () => {
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

  describe("DELETE /admin/users/:id", () => {
    // Users are deactivated, never deleted — audit history and file
    // ownership reference them.
    it("is not routed", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${regularUser.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );
      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

      const row = await prisma.user.findUnique({
        where: { id: regularUser.id },
      });
      expect(row).not.toBeNull();
    });
  });

  describe("system user", () => {
    it("cannot be modified through the admin API", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${SYSTEM_USER_ID}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ isActive: false }),
        }
      );
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBe("system_user");
    });

    it("cannot be given roles", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${SYSTEM_USER_ID}/roles`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ roleIds: [] }),
        }
      );
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });

  describe("GET /admin/users/:id/roles", () => {
    it("should return 200 with user roles list", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${adminUser.id}/roles`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      const data = (await response.json()) as UserRolesResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.userId).toBe(adminUser.id);
      expect(data.roles).toBeDefined();
      expect(Array.isArray(data.roles)).toBe(true);
    });

    it("should return 404 for non-existent user", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${NON_EXISTENT_UUID}/roles`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });

    it("should return 403 for a token without the permission", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${adminUser.id}/roles`,
        {
          headers: { Authorization: `Bearer ${regularToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });
  });

  describe("PUT /admin/users/:id/roles", () => {
    it("should set user roles", async () => {
      const role = await createTestRole();
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${regularUser.id}/roles`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ roleIds: [role.id] }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.OK);
      const body = (await response.json()) as UserRolesResponse;
      expect(body.roles.map((r) => r.id)).toEqual([role.id]);
    });

    it("returns 400 unknown_role for a role id that names no assignable role", async () => {
      const archived = await createTestRole();
      await prisma.role.update({
        where: { id: archived.id },
        data: { isActive: false, archivedAt: new Date() },
      });
      for (const roleId of [randomUUID(), archived.id]) {
        const response = await fetch(
          `${BASE_URL}/v1/admin/users/${regularUser.id}/roles`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${adminToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ roleIds: [roleId] }),
          }
        );
        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        const data = (await response.json()) as ErrorResponse;
        expect(data.error).toBe("unknown_role");
      }
    });

    it("keeps org-scoped assignments and lists only global roles", async () => {
      const user = await createTestUser();
      const org = await createTestOrganization(adminToken);
      await addTestOrgMember(adminToken, org.id, user.id);
      const orgRole = await createTestRole();
      const globalRole = await createTestRole();
      const headers = {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      };

      const orgPut = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({ roleIds: [orgRole.id] }),
        }
      );
      expect(orgPut.status).toBe(HTTP_STATUS.OK);

      const put = await fetch(`${BASE_URL}/v1/admin/users/${user.id}/roles`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ roleIds: [globalRole.id, globalRole.id] }),
      });
      expect(put.status).toBe(HTTP_STATUS.OK);
      const putData = (await put.json()) as UserRolesResponse;
      expect(putData.roles.map((r) => r.id)).toEqual([globalRole.id]);

      const assignments = await prisma.userRole.findMany({
        where: { userId: user.id },
      });
      expect(
        assignments.map((a) => [a.roleId, a.organizationId]).sort()
      ).toEqual(
        [
          [globalRole.id, null],
          [orgRole.id, org.id],
        ].sort()
      );

      const get = await fetch(`${BASE_URL}/v1/admin/users/${user.id}/roles`, {
        headers,
      });
      const getData = (await get.json()) as UserRolesResponse;
      expect(getData.roles.map((r) => r.id)).toEqual([globalRole.id]);

      const orgGet = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
        { headers }
      );
      const orgData = (await orgGet.json()) as UserRolesResponse;
      expect(orgData.roles.map((r) => r.id)).toEqual([orgRole.id]);
    });

    it("keeps the expiry of an assignment that stays, globally and per organization", async () => {
      const user = await createTestUser();
      const org = await createTestOrganization(adminToken);
      await addTestOrgMember(adminToken, org.id, user.id);
      const [kept, dropped, added] = await Promise.all([
        createTestRole(),
        createTestRole(),
        createTestRole(),
      ]);
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      for (const organizationId of [null, org.id]) {
        await prisma.userRole.createMany({
          data: [
            { userId: user.id, roleId: kept.id, organizationId, expiresAt },
            { userId: user.id, roleId: dropped.id, organizationId },
          ],
        });
      }
      const headers = {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      };
      const roleIds = [kept.id, added.id];

      const put = await fetch(`${BASE_URL}/v1/admin/users/${user.id}/roles`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ roleIds }),
      });
      expect(put.status).toBe(HTTP_STATUS.OK);
      const orgPut = await fetch(
        `${BASE_URL}/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
        { method: "PUT", headers, body: JSON.stringify({ roleIds }) }
      );
      expect(orgPut.status).toBe(HTTP_STATUS.OK);

      for (const res of [put, orgPut]) {
        const { roles } = (await res.json()) as {
          roles: { id: string; expiresAt: string | null }[];
        };
        expect(
          Object.fromEntries(roles.map((r) => [r.id, r.expiresAt]))
        ).toEqual({
          [kept.id]: expiresAt.toISOString(),
          [added.id]: null,
        });
      }
      expect(
        await prisma.userRole.count({
          where: { userId: user.id, roleId: dropped.id },
        })
      ).toBe(0);
    });
    it("keeps a held archived or retired role sent back from GET, globally and per organization", async () => {
      const user = await createTestUser();
      const org = await createTestOrganization(adminToken);
      await addTestOrgMember(adminToken, org.id, user.id);
      const [archived, retired] = await Promise.all([
        createTestRole(),
        createTestRole(),
      ]);
      for (const organizationId of [null, org.id]) {
        await prisma.userRole.createMany({
          data: [archived.id, retired.id].map((roleId) => ({
            userId: user.id,
            roleId,
            organizationId,
          })),
        });
      }
      await prisma.role.update({
        where: { id: archived.id },
        data: { isActive: false, archivedAt: new Date() },
      });
      await prisma.role.update({
        where: { id: retired.id },
        data: { retiredAt: new Date() },
      });
      const headers = {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      };

      for (const path of [
        `/v1/admin/users/${user.id}/roles`,
        `/v1/admin/organizations/${org.id}/members/${user.id}/roles`,
      ]) {
        const got = (await (
          await fetch(`${BASE_URL}${path}`, { headers })
        ).json()) as UserRolesResponse;
        const roleIds = got.roles.map((r) => r.id);
        expect(roleIds.sort()).toEqual([archived.id, retired.id].sort());
        const put = await fetch(`${BASE_URL}${path}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ roleIds }),
        });
        expect(put.status).toBe(HTTP_STATUS.OK);
      }
      expect(
        await prisma.userRole.count({
          where: { userId: user.id, roleId: { in: [archived.id, retired.id] } },
        })
      ).toBe(4);
    });
  });

  describe("GET /admin/users/:id/permissions", () => {
    it("should return 200 with user effective permissions", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${adminUser.id}/permissions`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      const data = (await response.json()) as PermissionsListResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.userId).toBe(adminUser.id);
      expect(data.permissions).toBeDefined();
      expect(Array.isArray(data.permissions)).toBe(true);
    });

    it("should return 404 for non-existent user", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${NON_EXISTENT_UUID}/permissions`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });

    it("should return 403 for a token without the permission", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${adminUser.id}/permissions`,
        {
          headers: { Authorization: `Bearer ${regularToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });
  });

  describe("GET /admin/users/:id/sessions", () => {
    it("should return 200 with user sessions list", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${adminUser.id}/sessions`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      const data = (await response.json()) as UserSessionsResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.userId).toBe(adminUser.id);
      expect(data.sessions).toBeDefined();
      expect(Array.isArray(data.sessions)).toBe(true);
    });

    it("should return 404 for non-existent user", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${NON_EXISTENT_UUID}/sessions`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });

    it("should return 403 for a token without the permission", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${adminUser.id}/sessions`,
        {
          headers: { Authorization: `Bearer ${regularToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });
  });

  describe("DELETE /admin/users/:id/sessions/all", () => {
    it("should return 200 with revocation details when revoking all user sessions", async () => {
      const target = await createTestUser();
      await getAccessTokenForUser(target, testClient);
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${target.id}/sessions/all`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ includeCurrentSession: false }),
        }
      );

      const data = (await response.json()) as RevokeAllSessionsResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.revokedCount).toBeGreaterThanOrEqual(1);
      expect(data.currentSessionRevoked).toBe(false);
    });

    it("should return 404 for non-existent user", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${NON_EXISTENT_UUID}/sessions/all`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ includeCurrentSession: false }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });

    it("should return 403 for a token without the permission", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${regularUser.id}/sessions/all`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${regularToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ includeCurrentSession: false }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });
  });

  describe("DELETE /admin/users/:id/sessions/:sessionId", () => {
    it("should return 204 when revoking a specific user session", async () => {
      // Create a test user and get them multiple sessions
      const sessionTestUser = await createTestUser();
      await getAccessTokenForUser(sessionTestUser, testClient);
      await getAccessTokenForUser(sessionTestUser, testClient);

      // Get user sessions
      const sessionsResponse = await fetch(
        `${BASE_URL}/v1/admin/users/${sessionTestUser.id}/sessions`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      expect(sessionsResponse.status).toBe(HTTP_STATUS.OK);
      const sessionsData =
        (await sessionsResponse.json()) as UserSessionsResponse;
      const sessions = sessionsData.sessions;

      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBeGreaterThanOrEqual(1);

      const sessionId = sessions[0].id;

      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${sessionTestUser.id}/sessions`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sessionId }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);
    });

    it("should return 404 for non-existent session", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${regularUser.id}/sessions`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sessionId: NON_EXISTENT_UUID }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });

    it("should return 403 for a token without the permission", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${regularUser.id}/sessions`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${regularToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sessionId: 123 }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });
  });

  describe("GET /admin/users/:id/totp", () => {
    it("should return 200 with TOTP status", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${regularUser.id}/totp`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.OK);

      const data = (await response.json()) as {
        totpEnabled: boolean;
        totpEnabledAt: string | null;
      };
      expect(typeof data.totpEnabled).toBe("boolean");
    });

    it("should return 404 for non-existent user", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${NON_EXISTENT_UUID}/totp`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });

    it("should return 403 for a token without the permission", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${regularUser.id}/totp`,
        {
          headers: { Authorization: `Bearer ${regularToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });
  });

  describe("POST /admin/users/:id/totp/reset", () => {
    const enrolledUser = async () => {
      const user = await createTestUser();
      await prisma.user.update({
        where: { id: user.id },
        data: {
          totpSecret: encryptTotpSecret(generateTotpSecret()),
          totpEnabled: true,
          totpEnabledAt: new Date(),
        },
      });
      await prisma.recoveryCode.createMany({
        data: ["a", "b", "c"].map((c) => ({ userId: user.id, codeHash: c })),
      });
      return user;
    };

    it("resets TOTP for an admin with only users.write, returning no codes", async () => {
      const writerToken = await getTestPrincipalToken({
        permissions: ["users.write"],
      });
      const endpoint = await createTestWebhookEndpoint(
        await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
        { eventTypes: ["auth.user.totp-reset"] }
      );
      const totpUser = await enrolledUser();

      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${totpUser.id}/totp/reset`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${writerToken}` },
        }
      );
      expect(response.status).toBe(HTTP_STATUS.OK);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty("recoveryCodes");
      expect(JSON.stringify(body)).not.toMatch(/codes?":/);

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: totpUser.id },
      });
      expect(after).toMatchObject({
        totpEnabled: false,
        totpSecret: null,
        totpEnabledAt: null,
      });
      expect(
        await prisma.recoveryCode.count({ where: { userId: totpUser.id } })
      ).toBe(0);

      const entry = await prisma.auditLogEntry.findFirst({
        where: {
          entityId: totpUser.id,
          entityType: "User",
          metadata: { path: ["action"], equals: "totp_reset" },
        },
      });
      expect(entry).toMatchObject({ action: "UPDATE" });

      const where = {
        webhookEndpointId: endpoint.id,
        eventType: "auth.user.totp-reset",
        payload: { path: ["entityId"], equals: totpUser.id },
      };
      await waitFor(
        async () => (await prisma.webhookDelivery.count({ where })) > 0,
        10_000
      );
    });

    it("no longer serves the recovery-codes route", async () => {
      const totpUser = await enrolledUser();
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${totpUser.id}/totp/recovery-codes`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );
      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      expect(
        await prisma.recoveryCode.count({ where: { userId: totpUser.id } })
      ).toBe(3);
    });

    it("should return 400 for user without TOTP enabled", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${regularUser.id}/totp/reset`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      // User doesn't have TOTP enabled
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });

    it("should return 404 for non-existent user", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${NON_EXISTENT_UUID}/totp/reset`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });

    it("should return 403 for a token without the permission", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/users/${regularUser.id}/totp/reset`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${regularToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });
  });
});

describe("Provider-only users, identities and invites", () => {
  let fake: FakeOidcProvider;
  let provider: { id: string; slug: string; displayName: string };
  let client: Awaited<ReturnType<typeof createTestClient>>;
  let adminToken: string;

  const createProvider = async () => {
    const res = await fetch(`${BASE_URL}/v1/admin/identity-providers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await getTestPrincipalToken({
          permissions: ["identity-providers.write"],
        })}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        slug: `inv-${generateUniqueId().toLowerCase()}`.slice(0, 40),
        displayName: `Invite ${generateUniqueId()}`,
        kind: "oidc",
        issuer: fake.issuer,
        clientId: fake.clientId,
        clientSecret: fake.clientSecret,
      }),
    });
    expect(res.status).toBe(HTTP_STATUS.CREATED);
    return (await res.json()) as typeof provider;
  };

  const admin = (method: string, path: string, body?: unknown) =>
    fetch(`${BASE_URL}/v1/admin/users${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const createUser = async (body: Record<string, unknown> = {}) => {
    const res = await admin("POST", "", {
      email: `provider-only-${generateUniqueId()}@example.com`,
      ...body,
    });
    expect(res.status).toBe(HTTP_STATUS.CREATED);
    return (await res.json()) as UserResponse & {
      id: string;
      email: string;
      hasPassword: boolean;
    };
  };

  beforeAll(async () => {
    fake = await startFakeOidcProvider();
    provider = await createProvider();
    client = await createTestClient();
    adminToken = await getTestPrincipalToken({
      permissions: ["users.read", "users.write"],
    });
  });

  afterAll(async () => {
    await fake.close();
  });

  it("creates a user without a password, hasPassword false", async () => {
    const user = await createUser();
    expect(user.hasPassword).toBe(false);
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(row.passwordHash).toBeNull();

    const read = await admin("GET", `/${user.id}`);
    expect(((await read.json()) as { hasPassword: boolean }).hasPassword).toBe(
      false
    );
  });

  it("still validates a password when one is given", async () => {
    const weak = await admin("POST", "", {
      email: `weak-${generateUniqueId()}@example.com`,
      password: "short",
    });
    expect(weak.status).toBe(HTTP_STATUS.BAD_REQUEST);

    const user = await createUser({ password: "Str0ng-Passw0rd!x" });
    expect(user.hasPassword).toBe(true);
  });

  it("invites a provider-only user, who then signs in through the provider", async () => {
    const user = await createUser();
    const invite = await admin("POST", `/${user.id}/identity-invites`, {
      providerId: provider.id,
    });
    expect(invite.status).toBe(HTTP_STATUS.CREATED);
    const issued = (await invite.json()) as {
      providerId: string;
      expiresAt: string;
    };
    expect(issued.providerId).toBe(provider.id);
    const ttl = new Date(issued.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(7 * 24 * 3600_000 - 60_000);
    expect(ttl).toBeLessThanOrEqual(7 * 24 * 3600_000);

    const before = await admin("GET", `/${user.id}/identities`);
    expect(before.status).toBe(HTTP_STATUS.OK);
    expect(await before.json()).toEqual({
      identities: [],
      invites: [
        {
          provider: {
            id: provider.id,
            slug: provider.slug,
            displayName: provider.displayName,
          },
          expiresAt: issued.expiresAt,
        },
      ],
    });

    const sub = `sub-${randomUUID()}`;
    const { location } = await upstreamLogin({
      provider: fake,
      slug: provider.slug,
      clientId: client.clientId,
      redirectUri: "http://localhost:3000/callback",
      scope: "openid profile email",
      claims: { sub, email: user.email, email_verified: true },
    });
    expect(location.pathname).toBe("/consent");

    const after = (await (
      await admin("GET", `/${user.id}/identities`)
    ).json()) as {
      identities: { provider: { slug: string } }[];
      invites: unknown[];
    };
    expect(after.invites).toEqual([]);
    expect(after.identities).toHaveLength(1);
    expect(after.identities[0].provider.slug).toBe(provider.slug);
  });

  it("refuses POST /account/password for a user with no password", async () => {
    const user = await createTestUser();
    const token = await getAccessTokenForUser(user, client);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: null },
    });
    const res = await fetch(`${BASE_URL}/v1/account/password`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        currentPassword: user.plainPassword,
        newPassword: "N3w-Str0ng-Passw0rd!",
      }),
    });
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(((await res.json()) as ErrorResponse).error).toBe("no_password");

    const me = await fetch(`${BASE_URL}/v1/account/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(((await me.json()) as { hasPassword: boolean }).hasPassword).toBe(
      false
    );
  });

  it("refuses an invite to an inactive provider with 400 provider_inactive", async () => {
    const inactive = await createProvider();
    await prisma.identityProvider.update({
      where: { id: inactive.id },
      data: { isActive: false },
    });
    const user = await createUser();
    const res = await admin("POST", `/${user.id}/identity-invites`, {
      providerId: inactive.id,
    });
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(((await res.json()) as ErrorResponse).error).toBe(
      "provider_inactive"
    );
  });

  it("refuses an invite at another provider than an SSO-only domain's with 409 sso_required", async () => {
    const domainOwner = await createProvider();
    const domain = `invsso-${generateUniqueId().toLowerCase()}.example`;
    await prisma.identityProviderDomain.create({
      data: {
        providerId: domainOwner.id,
        domain,
        organizationId: DEFAULT_ORGANIZATION_ID,
        ssoOnly: true,
        createdBy: SYSTEM_USER_ID,
      },
    });
    const user = await createUser({ email: `someone@${domain}` });

    const refused = await admin("POST", `/${user.id}/identity-invites`, {
      providerId: provider.id,
    });
    expect(refused.status).toBe(HTTP_STATUS.CONFLICT);
    expect(((await refused.json()) as ErrorResponse).error).toBe(
      "sso_required"
    );
    expect(
      await prisma.userIdentity.count({ where: { userId: user.id } })
    ).toBe(0);

    const own = await admin("POST", `/${user.id}/identity-invites`, {
      providerId: domainOwner.id,
    });
    expect(own.status).toBe(HTTP_STATUS.CREATED);
  });

  it("refuses an invite to an unknown provider with 400", async () => {
    const user = await createUser();
    const res = await admin("POST", `/${user.id}/identity-invites`, {
      providerId: NON_EXISTENT_UUID,
    });
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });

  it("withdraws an invite: 204, then 404", async () => {
    const user = await createUser();
    await admin("POST", `/${user.id}/identity-invites`, {
      providerId: provider.id,
    });
    const first = await admin(
      "DELETE",
      `/${user.id}/identity-invites/${provider.id}`
    );
    expect(first.status).toBe(HTTP_STATUS.NO_CONTENT);
    const second = await admin(
      "DELETE",
      `/${user.id}/identity-invites/${provider.id}`
    );
    expect(second.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it("emits an event when an invite is created and when it is withdrawn", async () => {
    const eventTypes = [
      "auth.user.identity-invite-created",
      "auth.user.identity-invite-withdrawn",
    ];
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes }
    );
    const user = await createUser();
    await admin("POST", `/${user.id}/identity-invites`, {
      providerId: provider.id,
    });
    const withdrawn = await admin(
      "DELETE",
      `/${user.id}/identity-invites/${provider.id}`
    );
    expect(withdrawn.status).toBe(HTTP_STATUS.NO_CONTENT);

    const where = {
      webhookEndpointId: endpoint.id,
      payload: { path: ["data", "userId"], equals: user.id },
    };
    await waitFor(
      async () => (await prisma.webhookDelivery.count({ where })) === 2,
      10_000
    );
    const deliveries = await prisma.webhookDelivery.findMany({ where });
    expect(deliveries.map((d) => d.eventType).sort()).toEqual(eventTypes);
  });

  it("withdraws a user's invites when an admin changes their email", async () => {
    const user = await createUser();
    await admin("POST", `/${user.id}/identity-invites`, {
      providerId: provider.id,
    });
    const res = await admin("PATCH", `/${user.id}`, {
      email: `moved-${generateUniqueId()}@example.com`,
    });
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(
      await prisma.identityInvite.count({ where: { userId: user.id } })
    ).toBe(0);
  });

  it("keeps a user's invites when an admin changes only their name", async () => {
    const user = await createUser();
    await admin("POST", `/${user.id}/identity-invites`, {
      providerId: provider.id,
    });
    const res = await admin("PATCH", `/${user.id}`, { name: "Renamed" });
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(
      await prisma.identityInvite.count({ where: { userId: user.id } })
    ).toBe(1);
  });

  it("needs users.read to list identities and users.write to invite", async () => {
    const user = await createUser();
    const none = await getTestPrincipalToken({ permissions: [] });
    const list = await fetch(
      `${BASE_URL}/v1/admin/users/${user.id}/identities`,
      {
        headers: { Authorization: `Bearer ${none}` },
      }
    );
    expect(list.status).toBe(HTTP_STATUS.FORBIDDEN);
    const readOnly = await getTestPrincipalToken({
      permissions: ["users.read"],
    });
    const invite = await fetch(
      `${BASE_URL}/v1/admin/users/${user.id}/identity-invites`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${readOnly}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ providerId: provider.id }),
      }
    );
    expect(invite.status).toBe(HTTP_STATUS.FORBIDDEN);
  });
});
