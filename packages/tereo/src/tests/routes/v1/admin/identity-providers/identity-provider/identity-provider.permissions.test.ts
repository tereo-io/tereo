// @module-tag int
// @module-tag auth

import { generateUniqueId } from "../../../../../support/auth/crypto.js";
import { SYSTEM_USER_ID } from "../../../../../../definitions/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../../support/coreUrl.js";
import {
  startFakeOidcProvider,
  FakeOidcProvider,
} from "../../../../../support/fakeOidcProvider.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../../../support/principals.js";

declare global {
  interface Response {
    // Test bodies are checked field by field.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json(): Promise<any>;
  }
}

const BASE = `${CORE_URL}/v1/admin/identity-providers`;

let fake: FakeOidcProvider;
let writeToken: string;
let adminToken: string;
let orgId: string;

beforeAll(async () => {
  fake = await startFakeOidcProvider();
  writeToken = await getTestPrincipalToken({
    permissions: ["identity-providers.write"],
  });
  // SSO-only changes and moving such a provider need a global admin.
  adminToken = await getTestPrincipalToken({ permissions: ["admin"] });
  orgId = await ensureTestOrganization(`idp-org-${generateUniqueId()}`);
});

afterAll(async () => {
  await fake.close();
});

const call = (token: string, method: string, path: string, body?: unknown) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const createProvider = async (overrides: Record<string, unknown> = {}) => {
  const response = await call(writeToken, "POST", "", {
    slug: `p-${generateUniqueId().toLowerCase()}`.slice(0, 40),
    displayName: "Fake IdP",
    kind: "oidc",
    issuer: fake.issuer,
    clientId: fake.clientId,
    clientSecret: fake.clientSecret,
    ...overrides,
  });
  return response;
};

const newProvider = async () => {
  const response = await createProvider();
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; slug: string };
};

describe("PATCH /v1/admin/identity-providers/:id", () => {
  it("lets only a global admin turn countsAsMfa on", async () => {
    const provider = await newProvider();
    const refused = await call(writeToken, "PATCH", `/${provider.id}`, {
      countsAsMfa: true,
    });
    expect(refused.status).toBe(403);

    const adminToken = await getTestPrincipalToken({
      permissions: ["admin"],
    });
    const allowed = await call(adminToken, "PATCH", `/${provider.id}`, {
      countsAsMfa: true,
    });
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).countsAsMfa).toBe(true);

    // Turning it off is not gated.
    const off = await call(writeToken, "PATCH", `/${provider.id}`, {
      countsAsMfa: false,
    });
    expect(off.status).toBe(200);
  });

  it("needs a global admin to move an MFA-counting provider to another issuer or client", async () => {
    const adminToken = await getTestPrincipalToken({
      permissions: ["admin"],
    });
    const provider = (await (
      await call(adminToken, "POST", "", {
        slug: `mfa-${generateUniqueId().toLowerCase()}`.slice(0, 40),
        displayName: "MFA IdP",
        kind: "oidc",
        issuer: fake.issuer,
        clientId: fake.clientId,
        clientSecret: fake.clientSecret,
        countsAsMfa: true,
      })
    ).json()) as { id: string };

    const other = await startFakeOidcProvider();
    try {
      const swapped = await call(writeToken, "PATCH", `/${provider.id}`, {
        issuer: other.issuer,
        clientId: other.clientId,
        clientSecret: other.clientSecret,
      });
      expect(swapped.status).toBe(403);
      const clientOnly = await call(writeToken, "PATCH", `/${provider.id}`, {
        clientId: "another-client",
        clientSecret: fake.clientSecret,
      });
      expect(clientOnly.status).toBe(403);
      const row = await prisma.identityProvider.findUniqueOrThrow({
        where: { id: provider.id },
      });
      expect(row.issuer).toBe(fake.issuer);
      expect(row.clientId).toBe(fake.clientId);

      // Dropping the flag in the same request needs no admin.
      const dropped = await call(writeToken, "PATCH", `/${provider.id}`, {
        issuer: other.issuer,
        clientId: other.clientId,
        clientSecret: other.clientSecret,
        countsAsMfa: false,
      });
      expect(dropped.status).toBe(200);
      expect((await dropped.json()).countsAsMfa).toBe(false);

      const byAdmin = await call(adminToken, "PATCH", `/${provider.id}`, {
        issuer: fake.issuer,
        clientId: fake.clientId,
        clientSecret: fake.clientSecret,
        countsAsMfa: true,
      });
      expect(byAdmin.status).toBe(200);

      // Renaming keeps who asserts the identity, so it is not gated.
      const renamed = await call(writeToken, "PATCH", `/${provider.id}`, {
        displayName: "Renamed MFA IdP",
      });
      expect(renamed.status).toBe(200);
    } finally {
      await other.close();
    }
  });

  it("needs a global admin to change the issuer or client of a provider with an SSO-only domain", async () => {
    const provider = await newProvider();
    await prisma.identityProviderDomain.create({
      data: {
        providerId: provider.id,
        domain: `ssoiss-${generateUniqueId().toLowerCase()}.com`,
        organizationId: orgId,
        ssoOnly: true,
        createdBy: SYSTEM_USER_ID,
      },
    });

    const other = await startFakeOidcProvider();
    try {
      const swapped = await call(writeToken, "PATCH", `/${provider.id}`, {
        issuer: other.issuer,
        clientId: other.clientId,
        clientSecret: other.clientSecret,
      });
      expect(swapped.status).toBe(403);
      const clientOnly = await call(writeToken, "PATCH", `/${provider.id}`, {
        clientId: "another-client",
        clientSecret: fake.clientSecret,
      });
      expect(clientOnly.status).toBe(403);
      const row = await prisma.identityProvider.findUniqueOrThrow({
        where: { id: provider.id },
      });
      expect(row.issuer).toBe(fake.issuer);
      expect(row.clientId).toBe(fake.clientId);

      const secretOnly = await call(writeToken, "PATCH", `/${provider.id}`, {
        clientSecret: fake.clientSecret,
      });
      expect(secretOnly.status).toBe(200);

      const byAdmin = await call(adminToken, "PATCH", `/${provider.id}`, {
        issuer: other.issuer,
        clientId: other.clientId,
        clientSecret: other.clientSecret,
      });
      expect(byAdmin.status).toBe(200);
    } finally {
      await other.close();
    }
  });
});
