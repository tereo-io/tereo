// @module-tag int
// @module-tag auth

import { getTestPrincipalToken } from "../../../../support/principals.js";
import { LOGIN_CLIENT } from "../../../../../definitions/index.js";
import { makeServiceOf } from "../../../../support/testService.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import {
  BASE_URL,
  HTTP_STATUS,
  createTestClient,
  createAdminUser,
  createTestUser,
  getAccessTokenForUser,
  generateUniqueId,
} from "../../../../support/auth.js";

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
let regularToken: string;
let managedClient: Awaited<ReturnType<typeof createTestClient>>;

beforeAll(async () => {
  const testClient = await createTestClient();
  const adminUser = await createAdminUser();
  const regularUser = await createTestUser();
  managedClient = await createTestClient({ clientType: "confidential" });

  adminToken = await getAccessTokenForUser(adminUser, testClient);
  regularToken = await getAccessTokenForUser(regularUser, testClient);
});

describe("GET /v1/admin/clients", () => {
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

describe("POST /v1/admin/clients", () => {
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

// Machine identities are services (/admin/services, tests/registry).
describe("POST /v1/admin/clients with client_credentials", () => {
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

describe("POST /v1/admin/clients and PATCH /v1/admin/clients/:id: audience and the login client's locked fields", () => {
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
