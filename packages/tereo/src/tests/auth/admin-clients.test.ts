import { getTestPrincipalToken } from "../utils/principals.js";
import { LOGIN_CLIENT } from "../../definitions/index.js";
import { describe, it, expect, beforeAll } from "vitest";
import { makeServiceOf } from "../utils/testService.js";
import { prisma } from "../../utils/db/prisma.js";
import { createHash } from "node:crypto";
import {
  BASE_URL,
  HTTP_STATUS,
  NON_EXISTENT_UUID,
  createTestClient,
  createAdminUser,
  createTestUser,
  getAccessTokenForUser,
  generateUniqueId,
} from "./utils/test-helpers.js";

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

const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");

describe("Admin Clients Endpoints", () => {
  let testClient: Awaited<ReturnType<typeof createTestClient>>;
  let adminUser: Awaited<ReturnType<typeof createAdminUser>>;
  let regularUser: Awaited<ReturnType<typeof createTestUser>>;
  let adminToken: string;
  let regularToken: string;
  let managedClient: Awaited<ReturnType<typeof createTestClient>>;

  beforeAll(async () => {
    testClient = await createTestClient();
    adminUser = await createAdminUser();
    regularUser = await createTestUser();
    managedClient = await createTestClient({ clientType: "confidential" });

    adminToken = await getAccessTokenForUser(adminUser, testClient);
    regularToken = await getAccessTokenForUser(regularUser, testClient);
  });

  describe("GET /admin/clients", () => {
    it("should list clients with admin token", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/clients`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      const data = (await response.json()) as ClientsListResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      // Response uses "data" key for the array
      expect(Array.isArray(data.data || data.clients)).toBe(true);
    });

    it("should return 401 with error for request without auth token", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/clients`);

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });

    it("should return 403 with error for request with non-admin token", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/clients`, {
        headers: { Authorization: `Bearer ${regularToken}` },
      });

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });
  });

  describe("POST /admin/clients", () => {
    it("should create a new public client", async () => {
      const uniqueId = generateUniqueId();
      const newClientData = {
        name: `New Client ${uniqueId}`,
        clientType: "public",
        redirectUris: ["http://localhost:3000/callback"],
        scopes: ["openid", "profile"],
        grantTypes: ["authorization_code"],
      };

      const response = await fetch(`${BASE_URL}/v1/admin/clients`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(newClientData),
      });

      const data = (await response.json()) as ClientResponse;

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(data.name).toBe(newClientData.name);
      expect(data.clientType).toBe("public");
      expect(data.clientId).toBeDefined();
    });

    it("defaults consentRequired to true", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/clients`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: `Consent default ${generateUniqueId()}`,
          clientType: "public",
          redirectUris: ["http://localhost:3000/callback"],
          grantTypes: ["authorization_code"],
        }),
      });
      expect(response.status).toBe(HTTP_STATUS.CREATED);
      const data = (await response.json()) as ClientResponse;
      expect(data.consentRequired).toBe(true);
    });

    it("persists postLogoutRedirectUris", async () => {
      const postLogoutRedirectUris = ["http://localhost:3000/logged-out"];
      const response = await fetch(`${BASE_URL}/v1/admin/clients`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: `Logout Client ${generateUniqueId()}`,
          clientType: "public",
          redirectUris: ["http://localhost:3000/callback"],
          postLogoutRedirectUris,
          scopes: ["openid"],
          grantTypes: ["authorization_code"],
        }),
      });
      const created = (await response.json()) as ClientResponse;
      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(created.postLogoutRedirectUris).toEqual(postLogoutRedirectUris);

      const read = await fetch(`${BASE_URL}/v1/admin/clients/${created.id}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const data = (await read.json()) as ClientResponse;
      expect(data.postLogoutRedirectUris).toEqual(postLogoutRedirectUris);
    });

    it("refuses redirect URIs with a script-capable scheme", async () => {
      // The login UI navigates to redirect URIs with location.href, so one of
      // these would run in its origin.
      for (const uri of [
        "javascript:alert(document.domain)",
        "JavaScript://x/%0aalert(1)",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox(1)",
      ]) {
        for (const field of ["redirectUris", "postLogoutRedirectUris"]) {
          const response = await fetch(`${BASE_URL}/v1/admin/clients`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${adminToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              name: `Script Client ${generateUniqueId()}`,
              clientType: "public",
              redirectUris: ["http://localhost:3000/callback"],
              [field]: [uri],
              scopes: ["openid"],
              grantTypes: ["authorization_code"],
            }),
          });
          expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        }
      }

      const update = await fetch(
        `${BASE_URL}/v1/admin/clients/${managedClient.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ redirectUris: ["javascript:alert(1)"] }),
        }
      );
      expect(update.status).toBe(HTTP_STATUS.BAD_REQUEST);

      // A native app's private-use scheme (RFC 8252) is still allowed.
      const native = await fetch(`${BASE_URL}/v1/admin/clients`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: `Native Client ${generateUniqueId()}`,
          clientType: "public",
          redirectUris: ["com.example.app:/oauth/callback"],
          scopes: ["openid"],
          grantTypes: ["authorization_code"],
        }),
      });
      expect(native.status).toBe(HTTP_STATUS.CREATED);
    });

    it("should create a new confidential client with secret, stored as its SHA-256", async () => {
      const uniqueId = generateUniqueId();
      const newClientData = {
        name: `Confidential Client ${uniqueId}`,
        clientType: "confidential",
        redirectUris: ["http://localhost:3000/callback"],
        scopes: ["openid", "profile"],
        grantTypes: ["authorization_code", "refresh_token"],
      };

      const response = await fetch(`${BASE_URL}/v1/admin/clients`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(newClientData),
      });

      const data = (await response.json()) as ClientResponse;

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(data.clientType).toBe("confidential");
      expect(data.clientSecret).toBeDefined(); // Should return secret on creation
      const row = await prisma.oAuthClient.findUniqueOrThrow({
        where: { clientId: data.clientId! },
      });
      expect(row.clientSecret).toBe(sha256Hex(data.clientSecret!));
    });

    it("should reject request from non-admin", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/clients`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${regularToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Test Client",
          clientType: "public",
          redirectUris: ["http://localhost:3000/callback"],
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it("should require redirectUris", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/clients`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Test Client",
          clientType: "public",
        }),
      });

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });

  describe("GET /admin/clients/:id", () => {
    it("should get client by ID", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/clients/${managedClient.id}`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      const data = (await response.json()) as ClientResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.id).toBe(managedClient.id);
      expect(data.clientId).toBe(managedClient.clientId);
    });

    it("should not return client secret in GET response", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/clients/${managedClient.id}`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      const data = (await response.json()) as ClientResponse;

      // Secret should not be returned after creation
      expect(data.clientSecret).toBeUndefined();
    });

    it("should return 404 for non-existent client", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/clients/${NON_EXISTENT_UUID}`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });
  });

  describe("PATCH /admin/clients/:id", () => {
    it("should update client name", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/clients/${managedClient.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "Updated Client Name" }),
        }
      );

      const data = (await response.json()) as ClientResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.name).toBe("Updated Client Name");
    });

    it("updates consentRequired and reads it back", async () => {
      const url = `${BASE_URL}/v1/admin/clients/${managedClient.id}`;
      const headers = {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      };
      const patch = await fetch(url, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ consentRequired: false }),
      });
      expect(patch.status).toBe(HTTP_STATUS.OK);
      expect(((await patch.json()) as ClientResponse).consentRequired).toBe(
        false
      );
      const get = await fetch(url, { headers });
      expect(((await get.json()) as ClientResponse).consentRequired).toBe(
        false
      );
    });

    it("should update redirect URIs", async () => {
      const newRedirectUris = [
        "http://localhost:3000/callback",
        "http://localhost:4000/callback",
      ];

      const response = await fetch(
        `${BASE_URL}/v1/admin/clients/${managedClient.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ redirectUris: newRedirectUris }),
        }
      );

      const data = (await response.json()) as ClientResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.redirectUris).toEqual(newRedirectUris);
    });

    it("updates postLogoutRedirectUris and leaves them when omitted", async () => {
      const postLogoutRedirectUris = [
        "http://localhost:3000/logged-out",
        "http://localhost:4000/logged-out",
      ];
      const patch = (body: Record<string, unknown>) =>
        fetch(`${BASE_URL}/v1/admin/clients/${managedClient.id}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

      const response = await patch({ postLogoutRedirectUris });
      const data = (await response.json()) as ClientResponse;
      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.postLogoutRedirectUris).toEqual(postLogoutRedirectUris);

      await patch({ name: "Renamed Logout Client" });
      const read = await fetch(
        `${BASE_URL}/v1/admin/clients/${managedClient.id}`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      const after = (await read.json()) as ClientResponse;
      expect(after.postLogoutRedirectUris).toEqual(postLogoutRedirectUris);
    });

    it("should update scopes", async () => {
      const newScopes = ["openid", "profile", "email"];

      const response = await fetch(
        `${BASE_URL}/v1/admin/clients/${managedClient.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ scopes: newScopes }),
        }
      );

      const data = (await response.json()) as ClientResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.scopes).toEqual(newScopes);
    });

    it("refuses an empty grantTypes, on update as on create", async () => {
      const send = (method: string, path: string, body: object) =>
        fetch(`${BASE_URL}/v1/admin/clients${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

      const update = await send("PATCH", `/${managedClient.id}`, {
        grantTypes: [],
      });
      expect(update.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const stored = await prisma.oAuthClient.findUniqueOrThrow({
        where: { id: managedClient.id },
      });
      expect(stored.grantTypes.length).toBeGreaterThan(0);

      const create = await send("POST", "", {
        name: `No Grants ${generateUniqueId()}`,
        clientType: "confidential",
        grantTypes: [],
      });
      expect(create.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("gives a client switched to confidential a secret, returned once, that authenticates it", async () => {
      const publicClient = await createTestClient({ clientType: "public" });
      const patch = (body: object) =>
        fetch(`${BASE_URL}/v1/admin/clients/${publicClient.id}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

      const response = await patch({ clientType: "confidential" });
      expect(response.status).toBe(HTTP_STATUS.OK);
      const data = (await response.json()) as ClientResponse;
      expect(data.clientType).toBe("confidential");
      expect(typeof data.clientSecret).toBe("string");
      const secret = data.clientSecret as string;

      const row = await prisma.oAuthClient.findUniqueOrThrow({
        where: { id: publicClient.id },
      });
      expect(row.clientSecret).toBeTruthy();
      expect(row.clientSecret).not.toBe(secret);

      const entry = await prisma.auditLogEntry.findFirstOrThrow({
        where: {
          entityId: publicClient.id,
          entityType: "OAuthClient",
          metadata: { path: ["action"], equals: "secret_generated" },
        },
      });
      expect(JSON.stringify(entry)).not.toContain(secret);
      expect(JSON.stringify(entry)).not.toContain(row.clientSecret);

      const introspect = (password: string) =>
        fetch(`${BASE_URL}/oauth/introspect`, {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${publicClient.clientId}:${password}`).toString("base64")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ token: "not-a-token" }),
        });
      expect((await introspect(secret)).status).toBe(HTTP_STATUS.OK);
      expect((await introspect("wrong-secret")).status).toBe(
        HTTP_STATUS.UNAUTHORIZED
      );

      // Only once: a later edit returns no secret and keeps the one issued.
      const later = await patch({ name: "Renamed Confidential" });
      expect(later.status).toBe(HTTP_STATUS.OK);
      expect(
        ((await later.json()) as ClientResponse).clientSecret
      ).toBeUndefined();
      expect((await introspect(secret)).status).toBe(HTTP_STATUS.OK);
    });

    it("refuses transferring ownership to an inactive user", async () => {
      const inactive = await createTestUser({ isActive: false });
      const client = await createTestClient({ clientType: "confidential" });
      const response = await fetch(
        `${BASE_URL}/v1/admin/clients/${client.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ownerId: inactive.id }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBe("invalid_owner");
      const row = await prisma.oAuthClient.findUniqueOrThrow({
        where: { id: client.id },
      });
      expect(row.ownerId).toBe(client.ownerId);
    });

    it("refuses transferring ownership to an id that names no user", async () => {
      const client = await createTestClient({ clientType: "confidential" });
      const response = await fetch(
        `${BASE_URL}/v1/admin/clients/${client.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ownerId: NON_EXISTENT_UUID }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBe("unknown_user");
    });

    it("refuses leaving a public client without a redirect URI: 400 invalid_request", async () => {
      const client = await createTestClient({ clientType: "public" });
      const response = await fetch(
        `${BASE_URL}/v1/admin/clients/${client.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ redirectUris: [] }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBe("invalid_request");
    });

    it("transfers ownership to an active human", async () => {
      const owner = await createTestUser();
      const client = await createTestClient({ clientType: "confidential" });
      const response = await fetch(
        `${BASE_URL}/v1/admin/clients/${client.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ownerId: owner.id }),
        }
      );

      expect(response.status).toBe(HTTP_STATUS.OK);
      const row = await prisma.oAuthClient.findUniqueOrThrow({
        where: { id: client.id },
      });
      expect(row.ownerId).toBe(owner.id);
    });

    it("should return 404 for non-existent client", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/clients/${NON_EXISTENT_UUID}`,
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
  });

  describe("POST /admin/clients/:id/regenerate-secret", () => {
    it("should regenerate client secret for confidential client, stored as its SHA-256", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/clients/${managedClient.id}/regenerate-secret`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      const data = (await response.json()) as ClientResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.clientSecret).toBeDefined();
      const row = await prisma.oAuthClient.findUniqueOrThrow({
        where: { id: managedClient.id },
      });
      expect(row.clientSecret).toBe(sha256Hex(data.clientSecret!));
    });

    it("retires the replaced secret", async () => {
      const before = await prisma.oAuthClient.findUniqueOrThrow({
        where: { id: managedClient.id },
      });
      const response = await fetch(
        `${BASE_URL}/v1/admin/clients/${managedClient.id}/regenerate-secret`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );
      expect(response.status).toBe(HTTP_STATUS.OK);
      const row = await prisma.oAuthClient.findUniqueOrThrow({
        where: { id: managedClient.id },
      });
      expect(row.retiredSecretHashes).toContain(before.clientSecret);
      expect(row.retiredSecretHashes).not.toContain(row.clientSecret);
    });

    it("refuses a public client, which has no secret: 400 invalid_request", async () => {
      const client = await createTestClient({ clientType: "public" });
      const response = await fetch(
        `${BASE_URL}/v1/admin/clients/${client.id}/regenerate-secret`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBe("invalid_request");
    });
  });

  describe("a caller who neither owns the client nor holds clients.admin", () => {
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

  describe("DELETE /admin/clients/:id", () => {
    it("refuses to delete the admin UI's login client", async () => {
      const loginClient = await prisma.oAuthClient.findUniqueOrThrow({
        where: { clientId: LOGIN_CLIENT.clientId },
      });
      const response = await fetch(
        `${BASE_URL}/v1/admin/clients/${loginClient.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );
      expect(response.status).toBe(HTTP_STATUS.CONFLICT);
      expect(
        await prisma.oAuthClient.count({ where: { id: loginClient.id } })
      ).toBe(1);
    });

    it("should return 204 when deleting client", async () => {
      // Create a client to delete
      const clientToDelete = await createTestClient();

      const response = await fetch(
        `${BASE_URL}/v1/admin/clients/${clientToDelete.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);

      // Verify client is deleted
      const getResponse = await fetch(
        `${BASE_URL}/v1/admin/clients/${clientToDelete.id}`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      expect(getResponse.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("deactivates the service-account user instead of deleting it", async () => {
      const clientToDelete = await createTestClient({
        clientType: "confidential",
        grantTypes: ["client_credentials"],
      });
      const serviceAccount = await prisma.user.findUniqueOrThrow({
        where: { oauthClientId: clientToDelete.id },
      });

      const response = await fetch(
        `${BASE_URL}/v1/admin/clients/${clientToDelete.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );
      expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);

      const after = await prisma.user.findUnique({
        where: { id: serviceAccount.id },
      });
      expect(after).toMatchObject({ isActive: false, oauthClientId: null });
    });

    it("should return 404 for non-existent client", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/clients/${NON_EXISTENT_UUID}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${adminToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });

    it("should return 403 for request without admin token", async () => {
      const response = await fetch(
        `${BASE_URL}/v1/admin/clients/${managedClient.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${regularToken}` },
        }
      );

      expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);

      const data = (await response.json()) as ErrorResponse;
      expect(data.error).toBeDefined();
    });
  });

  describe("a service's client", () => {
    let serviceClient: Awaited<ReturnType<typeof createTestClient>>;
    let slug: string;

    beforeAll(async () => {
      serviceClient = await createTestClient({ clientType: "confidential" });
      slug = await makeServiceOf(serviceClient.id);
    });

    const call = (path: string, method = "GET", body?: unknown) =>
      fetch(`${BASE_URL}/v1/admin/clients${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    it("names its service on GET, in the list, and is null otherwise", async () => {
      const one = (await (
        await call(`/${serviceClient.id}`)
      ).json()) as ClientResponse;
      expect(one.service).toMatchObject({ slug, name: slug });

      const list = (await (
        await call(
          `?filter[clientId]=${serviceClient.clientId}&filter[clientId_op]=equals`
        )
      ).json()) as ClientsListResponse;
      expect(list.data?.[0]?.service?.slug).toBe(slug);

      const plain = (await (
        await call(`/${managedClient.id}`)
      ).json()) as ClientResponse;
      expect(plain.service).toBeNull();
    });

    it("refuses edit, delete and secret regeneration with 409", async () => {
      const id = serviceClient.id;
      expect((await call(`/${id}`, "PATCH", { name: "x" })).status).toBe(
        HTTP_STATUS.CONFLICT
      );
      expect((await call(`/${id}/regenerate-secret`, "POST")).status).toBe(
        HTTP_STATUS.CONFLICT
      );
      expect((await call(`/${id}`, "DELETE")).status).toBe(
        HTTP_STATUS.CONFLICT
      );
    });
  });

  // Machine identities are services (/admin/services, tests/registry).
  describe("client_credentials", () => {
    it("is refused: a machine identity is added as a service", async () => {
      const response = await fetch(`${BASE_URL}/v1/admin/clients`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: `Machine ${generateUniqueId()}`,
          clientType: "confidential",
          redirectUris: [],
          scopes: ["openid"],
          grantTypes: ["client_credentials"],
        }),
      });
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });
});

describe("Admin Clients: audience and the login client's locked fields", () => {
  let approver: string;
  let writer: string;
  let clientsAdmin: string;
  let slugA: string;
  let slugB: string;

  const send = (token: string, method: string, path: string, body?: unknown) =>
    fetch(`${BASE_URL}/v1/admin/clients${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const loginClientBody = (extra: Record<string, unknown> = {}) => ({
    name: `Login ${generateUniqueId()}`,
    clientType: "public",
    redirectUris: ["http://localhost:3000/callback"],
    grantTypes: ["authorization_code"],
    ...extra,
  });

  beforeAll(async () => {
    approver = await getTestPrincipalToken({
      permissions: ["clients.write", "clients.read", "services.approve"],
    });
    writer = await getTestPrincipalToken({
      permissions: ["clients.write", "clients.read"],
    });
    clientsAdmin = await getTestPrincipalToken({
      permissions: ["clients.admin"],
    });
    slugA = await makeServiceOf((await createTestClient()).id);
    slugB = await makeServiceOf((await createTestClient()).id);
  });

  it("sets a login client's audience to existing services", async () => {
    const created = await send(
      approver,
      "POST",
      "",
      loginClientBody({ audience: [slugB, slugA, slugB] })
    );
    expect(created.status).toBe(HTTP_STATUS.CREATED);
    const client = (await created.json()) as ClientResponse;
    expect(client.audience).toEqual([slugA, slugB].sort());

    const patched = await send(approver, "PATCH", `/${client.id}`, {
      audience: [slugA],
    });
    expect(patched.status).toBe(HTTP_STATUS.OK);
    expect(((await patched.json()) as ClientResponse).audience).toEqual([
      slugA,
    ]);
  });

  it("defaults the audience to empty", async () => {
    const created = await send(writer, "POST", "", loginClientBody());
    expect(created.status).toBe(HTTP_STATUS.CREATED);
    expect(((await created.json()) as ClientResponse).audience).toEqual([]);
  });

  it("refuses an audience naming core, an unknown slug, or nothing", async () => {
    const response = await send(
      approver,
      "POST",
      "",
      loginClientBody({ audience: ["core", "no-such-service", slugA] })
    );
    expect(response.status).toBe(422);
    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBe("invalid_audience");
    expect(data.error_description).toContain("core");
    expect(data.error_description).toContain("no-such-service");
    expect(data.error_description).not.toContain(slugA);

    const empty = await send(
      approver,
      "POST",
      "",
      loginClientBody({ audience: [""] })
    );
    expect(empty.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });

  it("requires services.approve to set or change an audience", async () => {
    const refused = await send(
      writer,
      "POST",
      "",
      loginClientBody({ audience: [slugA] })
    );
    expect(refused.status).toBe(HTTP_STATUS.FORBIDDEN);

    const created = await send(
      approver,
      "POST",
      "",
      loginClientBody({ audience: [slugA] })
    );
    const client = (await created.json()) as ClientResponse;
    const owned = await getTestPrincipalToken({
      permissions: ["clients.admin"],
    });

    const change = await send(owned, "PATCH", `/${client.id}`, {
      audience: [slugB],
    });
    expect(change.status).toBe(HTTP_STATUS.FORBIDDEN);

    const unchanged = await send(owned, "PATCH", `/${client.id}`, {
      name: "Renamed",
      audience: [slugA],
    });
    expect(unchanged.status).toBe(HTTP_STATUS.OK);
  });

  it("refuses to edit consentRequired or audience on core's login client", async () => {
    const loginClient = await prisma.oAuthClient.findUniqueOrThrow({
      where: { clientId: LOGIN_CLIENT.clientId },
    });
    for (const body of [{ consentRequired: false }, { audience: [slugA] }]) {
      const response = await send(
        clientsAdmin,
        "PATCH",
        `/${loginClient.id}`,
        body
      );
      expect(response.status).toBe(HTTP_STATUS.CONFLICT);
    }
  });
});
