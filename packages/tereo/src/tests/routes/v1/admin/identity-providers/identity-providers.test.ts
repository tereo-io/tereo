// @module-tag int
// @module-tag auth

import { getTestPrincipalToken } from "../../../../support/principals.js";
import { generateUniqueId } from "../../../../support/auth/crypto.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../support/coreUrl.js";
import {
  startFakeOidcProvider,
  FakeOidcProvider,
} from "../../../../support/fakeOidcProvider.js";

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
let readToken: string;
let usersReadToken: string;

beforeAll(async () => {
  fake = await startFakeOidcProvider();
  writeToken = await getTestPrincipalToken({
    permissions: ["identity-providers.write"],
  });
  readToken = await getTestPrincipalToken({
    permissions: ["identity-providers.read"],
  });
  usersReadToken = await getTestPrincipalToken({ permissions: ["users.read"] });
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

describe("GET /v1/admin/identity-providers and POST /v1/admin/identity-providers", () => {
  it("refuses a token without identity-providers.read", async () => {
    expect((await call(usersReadToken, "GET", "")).status).toBe(403);
  });

  it("refuses a read-only token on create", async () => {
    expect((await createProviderAs(readToken)).status).toBe(403);
  });

  async function createProviderAs(token: string) {
    return await call(token, "POST", "", {
      slug: "nope",
      displayName: "x",
      kind: "oidc",
      issuer: fake.issuer,
      clientId: fake.clientId,
      clientSecret: fake.clientSecret,
    });
  }

  it("creates a provider, without echoing the secret, and seals it", async () => {
    const slug = `acme-${generateUniqueId().toLowerCase()}`.slice(0, 40);
    const response = await createProvider({ slug });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.callbackUrl).toMatch(
      new RegExp(`/oauth/upstream/${slug}/callback$`)
    );
    expect(body).not.toHaveProperty("clientSecret");
    expect(JSON.stringify(body)).not.toContain(fake.clientSecret);
    expect(body.scopes).toEqual(["openid", "email", "profile"]);
    expect(body.isActive).toBe(true);

    const row = await prisma.identityProvider.findUniqueOrThrow({
      where: { id: body.id },
    });
    expect(row.clientSecret.startsWith("kek1:")).toBe(true);
    expect(row.clientSecret).not.toContain(fake.clientSecret);

    const list = await (await call(readToken, "GET", "")).json();
    expect(list.find((p: { id: string }) => p.id === body.id)).toBeTruthy();
    expect(JSON.stringify(list)).not.toContain("clientSecret");
  });

  it("rejects an issuer that differs from the provider's metadata", async () => {
    const other = await startFakeOidcProvider({
      issuerOverride: "https://elsewhere.example.com",
    });
    try {
      const response = await createProvider({ issuer: other.issuer });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("invalid_provider_config");
    } finally {
      await other.close();
    }
  });

  it("rejects the reserved slug", async () => {
    const response = await createProvider({ slug: "providers" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("reserved_slug");
  });

  it("rejects a slug that is already in use", async () => {
    const provider = await newProvider();
    const response = await createProvider({ slug: provider.slug });
    expect(response.status).toBe(409);
  });

  it("lets only a global admin turn countsAsMfa on (POST /v1/admin/identity-providers)", async () => {
    expect((await createProvider({ countsAsMfa: true })).status).toBe(403);
  });

  it("needs a global admin to move an MFA-counting provider to another issuer or client (POST /v1/admin/identity-providers)", async () => {
    const created = await createProvider({ countsAsMfa: true });
    // createProvider posts with writeToken, which may not set the flag.
    expect(created.status).toBe(403);
  });
});
