// @module-tag int
// @module-tag auth

import { LOGIN_CLIENT } from "../../../../../../definitions/index.js";
import { makeServiceOf } from "../../../../../support/testService.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
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
} from "../../../../../support/auth.js";

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

let adminToken: string;
let managedClient: Awaited<ReturnType<typeof createTestClient>>;

beforeAll(async () => {
  const testClient = await createTestClient();
  const adminUser = await createAdminUser();
  managedClient = await createTestClient({ clientType: "confidential" });

  adminToken = await getAccessTokenForUser(adminUser, testClient);
});

describe("GET /v1/admin/clients/:id", () => {
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

describe("PATCH /v1/admin/clients/:id", () => {
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
    expect(((await get.json()) as ClientResponse).consentRequired).toBe(false);
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
    const error = (await update.json()) as {
      error?: string;
      error_description?: string;
    };
    expect(error.error).toBe("invalid_request");
    expect(error.error_description).toMatch(
      /^Invalid request body\. grantTypes: /
    );
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
    expect(entry.changes).toEqual({
      clientType: { old: "public", new: "confidential" },
    });

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
    const response = await fetch(`${BASE_URL}/v1/admin/clients/${client.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ownerId: inactive.id }),
    });

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
    const response = await fetch(`${BASE_URL}/v1/admin/clients/${client.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ownerId: NON_EXISTENT_UUID }),
    });

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBe("unknown_user");
  });

  it("refuses leaving a public client without a redirect URI: 400 invalid_request", async () => {
    const client = await createTestClient({ clientType: "public" });
    const response = await fetch(`${BASE_URL}/v1/admin/clients/${client.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ redirectUris: [] }),
    });

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBe("invalid_request");
  });

  it("transfers ownership to an active human", async () => {
    const owner = await createTestUser();
    const client = await createTestClient({ clientType: "confidential" });
    const response = await fetch(`${BASE_URL}/v1/admin/clients/${client.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ownerId: owner.id }),
    });

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

describe("POST /v1/admin/clients/:id/regenerate-secret", () => {
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

describe("DELETE /v1/admin/clients/:id", () => {
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
});

describe("GET /v1/admin/clients, GET, PATCH and DELETE /v1/admin/clients/:id and POST /v1/admin/clients/:id/regenerate-secret for a service's client", () => {
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
    expect((await call(`/${id}`, "DELETE")).status).toBe(HTTP_STATUS.CONFLICT);
  });
});
