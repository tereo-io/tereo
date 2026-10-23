// @module-tag int
// @module-tag auth

import { BASE_URL, HTTP_STATUS } from "../../../../support/auth/constants.js";
import { getTestPrincipalToken } from "../../../../support/principals.js";
import { getAccessTokenForUser } from "../../../../support/auth/login.js";
import { createTestClient } from "../../../../support/auth/clients.js";
import { generateUniqueId } from "../../../../support/auth/crypto.js";
import { makeServiceOf } from "../../../../support/testService.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import {
  createAdminUser,
  createTestUser,
} from "../../../../support/auth/users.js";

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
        grantTypes: ["authorization_code"],
      }),
    });

    expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    const error = (await response.json()) as {
      error?: string;
      error_description?: string;
    };
    expect(error.error).toBe("invalid_request");
    expect(error.error_description).toMatch(
      /^Invalid request body\. redirectUris: /
    );
  });
});

describe("POST /v1/admin/clients and PATCH /v1/admin/clients/:id: audience", () => {
  let approver: string;
  let writer: string;
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
});
