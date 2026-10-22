// @module-tag int
// @module-tag auth

import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { getAccessTokenForUser } from "../../../../../support/auth/login.js";
import { createTestClient } from "../../../../../support/auth/clients.js";
import { generateUniqueId } from "../../../../../support/auth/crypto.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import {
  BASE_URL,
  HTTP_STATUS,
} from "../../../../../support/auth/constants.js";
import {
  createAdminUser,
  createTestUser,
} from "../../../../../support/auth/users.js";

interface ServiceAccountUser {
  id: string;
  email: string;
  name: string | null;
  userType: string;
}

interface ClientResponse {
  id?: string;
  clientId?: string;
  clientSecret?: string;
  clientType?: string;
  name?: string;
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
  scopes?: string[];
  serviceAccountUser?: ServiceAccountUser | null;
  service?: { id: string; slug: string; name: string } | null;
  [key: string]: unknown;
}

interface ClientsListResponse {
  data?: ClientResponse[];
  clients?: ClientResponse[];
  [key: string]: unknown;
}

interface ErrorResponse {
  error?: string;
  error_description?: string;
  message?: string;
  [key: string]: unknown;
}

let adminToken: string;
let managedClient: Awaited<ReturnType<typeof createTestClient>>;

beforeAll(async () => {
  const testClient = await createTestClient();
  const adminUser = await createAdminUser();
  managedClient = await createTestClient({ clientType: "confidential" });

  adminToken = await getAccessTokenForUser(adminUser, testClient);
});

describe("GET /v1/admin/clients, GET, PATCH and DELETE /v1/admin/clients/:id and POST /v1/admin/clients/:id/regenerate-secret for a caller who neither owns the client nor holds clients.admin", () => {
  let token: string;

  beforeAll(async () => {
    token = await getTestPrincipalToken({
      permissions: ["clients.read", "clients.write", "clients.delete"],
    });
  });

  it.each([
    ["GET", ""],
    ["PATCH", ""],
    ["DELETE", ""],
    ["POST", "/regenerate-secret"],
  ])("gets 403 forbidden from %s %s", async (method, suffix) => {
    const response = await fetch(
      `${BASE_URL}/v1/admin/clients/${managedClient.id}${suffix}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(method === "PATCH" && {
          body: JSON.stringify({ name: "Not Mine" }),
        }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBe("forbidden");
  });

  it("lists only the clients they own", async () => {
    const owner = await createTestUser();
    const ownerToken = await getTestPrincipalToken({
      userId: owner.id,
      permissions: ["clients.read"],
    });
    const own = await createTestClient({ ownerId: owner.id });

    const response = await fetch(`${BASE_URL}/v1/admin/clients?limit=200`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(response.status).toBe(HTTP_STATUS.OK);
    const data = (await response.json()) as ClientsListResponse;
    expect(data.data?.map((c) => c.id)).toEqual([own.id]);
  });

  it("still gets 400 invalid_owner from an admin moving ownership to a non-human", async () => {
    const serviceAccount = await prisma.user.create({
      data: {
        email: `svc-${generateUniqueId()}@test.local`,
        userType: "service_account",
        passwordHash: "!",
      },
    });
    const response = await fetch(
      `${BASE_URL}/v1/admin/clients/${managedClient.id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ownerId: serviceAccount.id }),
      }
    );

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBe("invalid_owner");
  });
});
