// @module-tag int
// @module-tag auth

import { openProviderSecret } from "../../../../../../utils/identityProviders/clientSecret.js";
import { DEFAULT_ORGANIZATION_ID } from "../../../../../../definitions/index.js";
import { generateUniqueId } from "../../../../../support/auth/crypto.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../../support/coreUrl.js";
import { randomUUID } from "node:crypto";
import {
  startFakeOidcProvider,
  FakeOidcProvider,
} from "../../../../../support/fakeOidcProvider.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../../../support/principals.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../../support/webhooks.js";

declare global {
  interface Response {
    // Test bodies are checked field by field.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json(): Promise<any>;
  }
}

const BASE = `${CORE_URL}/v1/admin/identity-providers`;

let fake: FakeOidcProvider;
let eventsEndpointId: string;
let writeToken: string;
let readToken: string;
let adminToken: string;
let orgId: string;

beforeAll(async () => {
  fake = await startFakeOidcProvider();
  const endpoint = await createTestWebhookEndpoint(
    await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
    {
      eventTypes: [
        "auth.identity-provider.created",
        "auth.identity-provider.deactivated",
        "auth.identity-provider.activated",
        "auth.identity-provider.domain-created",
        "auth.identity-provider.domain-updated",
        "auth.identity-provider.domain-deleted",
      ],
    }
  );
  eventsEndpointId = endpoint.id;
  writeToken = await getTestPrincipalToken({
    permissions: ["identity-providers.write"],
  });
  readToken = await getTestPrincipalToken({
    permissions: ["identity-providers.read"],
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

// The reaper deletes outbox rows once it fans them out, so the deliveries
// are the durable record of what a provider emitted.
const deliveredEventTypes = async (providerId: string, expected: string[]) => {
  const where = {
    webhookEndpointId: eventsEndpointId,
    payload: { path: ["entityId"], equals: providerId },
  };
  const types = async () =>
    (
      await prisma.webhookDelivery.findMany({
        where,
        select: { eventType: true },
      })
    ).map((d) => d.eventType);
  await waitFor(async () => {
    const seen = await types();
    return expected.every((t) => seen.includes(t));
  }, 10_000).catch(() => undefined);
  return types();
};

const postDomain = (token: string, providerId: string, body: object) =>
  call(token, "POST", `/${providerId}/domains`, {
    organizationId: orgId,
    autoAccept: false,
    ssoOnly: false,
    roleIds: [],
    ...body,
  });

describe("GET and PATCH /v1/admin/identity-providers/:id, POST /v1/admin/identity-providers/:id/activate and /deactivate", () => {
  it("keeps the stored secret when a PATCH omits it", async () => {
    const provider = await newProvider();
    const before = await prisma.identityProvider.findUniqueOrThrow({
      where: { id: provider.id },
    });

    const response = await call(writeToken, "PATCH", `/${provider.id}`, {
      displayName: "Renamed",
      scopes: ["openid", "email"],
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.displayName).toBe("Renamed");
    expect(body).not.toHaveProperty("clientSecret");

    const after = await prisma.identityProvider.findUniqueOrThrow({
      where: { id: provider.id },
    });
    expect(after.clientSecret).toBe(before.clientSecret);
    expect(after.scopes).toEqual(["openid", "email"]);
  });

  it("seals a replacement secret under the provider's id", async () => {
    const provider = await newProvider();
    const before = await prisma.identityProvider.findUniqueOrThrow({
      where: { id: provider.id },
    });

    const response = await call(writeToken, "PATCH", `/${provider.id}`, {
      clientSecret: "a-new-secret",
    });
    expect(response.status).toBe(200);

    const after = await prisma.identityProvider.findUniqueOrThrow({
      where: { id: provider.id },
    });
    expect(after.clientSecret).not.toBe(before.clientSecret);
    expect(after.clientSecret.startsWith("kek1:")).toBe(true);
    expect(await openProviderSecret(after)).toBe("a-new-secret");
  });

  it("refuses a slug change once identities exist", async () => {
    const provider = await newProvider();
    const user = await prisma.user.create({
      data: { email: `idp-${randomUUID()}@example.com`, name: "Linked" },
    });
    await prisma.userIdentity.create({
      data: { userId: user.id, providerId: provider.id, subject: "sub-1" },
    });

    const response = await call(writeToken, "PATCH", `/${provider.id}`, {
      slug: "renamed-slug",
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("slug_in_use");
  });

  it("refuses an issuer change once identities exist", async () => {
    const provider = await newProvider();
    const user = await prisma.user.create({
      data: { email: `idp-${randomUUID()}@example.com`, name: "Linked" },
    });
    await prisma.userIdentity.create({
      data: { userId: user.id, providerId: provider.id, subject: "sub-1" },
    });
    const other = await startFakeOidcProvider();
    try {
      const response = await call(writeToken, "PATCH", `/${provider.id}`, {
        issuer: other.issuer,
        clientId: other.clientId,
        clientSecret: other.clientSecret,
      });
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("issuer_in_use");
      const row = await prisma.identityProvider.findUniqueOrThrow({
        where: { id: provider.id },
      });
      expect(row.issuer).toBe(fake.issuer);

      const unchanged = await call(writeToken, "PATCH", `/${provider.id}`, {
        issuer: fake.issuer,
        displayName: "Same issuer",
      });
      expect(unchanged.status).toBe(200);
    } finally {
      await other.close();
    }
  });

  it("changes the issuer while no identity exists", async () => {
    const provider = await newProvider();
    const other = await startFakeOidcProvider();
    try {
      const response = await call(writeToken, "PATCH", `/${provider.id}`, {
        issuer: other.issuer,
        clientId: other.clientId,
        clientSecret: other.clientSecret,
      });
      expect(response.status).toBe(200);
      expect((await response.json()).issuer).toBe(other.issuer);
    } finally {
      await other.close();
    }
  });

  it("refuses an issuer change while identity invites are pending", async () => {
    const provider = await newProvider();
    const user = await prisma.user.create({
      data: { email: `idp-${randomUUID()}@example.com`, name: "Invited" },
    });
    const creator = await prisma.user.create({
      data: { email: `idp-${randomUUID()}@example.com`, name: "Admin" },
    });
    await prisma.identityInvite.create({
      data: {
        userId: user.id,
        providerId: provider.id,
        createdBy: creator.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const other = await startFakeOidcProvider();
    try {
      const response = await call(writeToken, "PATCH", `/${provider.id}`, {
        issuer: other.issuer,
        clientId: other.clientId,
        clientSecret: other.clientSecret,
      });
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("provider_has_invites");
    } finally {
      await other.close();
    }
  });

  it("needs the client secret to change the issuer or client ID", async () => {
    const provider = await newProvider();
    const other = await startFakeOidcProvider();
    try {
      const issuerOnly = await call(writeToken, "PATCH", `/${provider.id}`, {
        issuer: other.issuer,
      });
      expect(issuerOnly.status).toBe(400);
      expect((await issuerOnly.json()).error).toBe("client_secret_required");

      const clientOnly = await call(writeToken, "PATCH", `/${provider.id}`, {
        clientId: "another-client",
      });
      expect(clientOnly.status).toBe(400);
      expect((await clientOnly.json()).error).toBe("client_secret_required");

      const row = await prisma.identityProvider.findUniqueOrThrow({
        where: { id: provider.id },
      });
      expect(row.issuer).toBe(fake.issuer);
      expect(row.clientId).toBe(fake.clientId);

      // Sending the current values is no change.
      const same = await call(writeToken, "PATCH", `/${provider.id}`, {
        issuer: fake.issuer,
        clientId: fake.clientId,
      });
      expect(same.status).toBe(200);
    } finally {
      await other.close();
    }
  });

  it("changes the slug while no identity exists", async () => {
    const provider = await newProvider();
    const slug = `moved-${generateUniqueId().toLowerCase()}`.slice(0, 40);
    const response = await call(writeToken, "PATCH", `/${provider.id}`, {
      slug,
    });
    expect(response.status).toBe(200);
    expect((await response.json()).callbackUrl).toContain(`/${slug}/callback`);
  });

  it("404s an unknown provider", async () => {
    expect((await call(readToken, "GET", `/${randomUUID()}`)).status).toBe(404);
  });

  it("refuses to activate a provider whose issuer is unreachable", async () => {
    const own = await startFakeOidcProvider();
    const created = await createProvider({ issuer: own.issuer });
    expect(created.status).toBe(201);
    const provider = await created.json();
    expect(
      (await call(writeToken, "POST", `/${provider.id}/deactivate`)).status
    ).toBe(200);
    await own.close();

    const response = await call(writeToken, "POST", `/${provider.id}/activate`);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("provider_unreachable");
    const row = await prisma.identityProvider.findUniqueOrThrow({
      where: { id: provider.id },
    });
    expect(row.isActive).toBe(false);
  });

  it("deactivates and activates, emitting events", async () => {
    const provider = await newProvider();
    const off = await call(writeToken, "POST", `/${provider.id}/deactivate`);
    expect(off.status).toBe(200);
    expect((await off.json()).isActive).toBe(false);
    const on = await call(writeToken, "POST", `/${provider.id}/activate`);
    expect((await on.json()).isActive).toBe(true);

    const expected = [
      "auth.identity-provider.created",
      "auth.identity-provider.deactivated",
      "auth.identity-provider.activated",
    ];
    expect(await deliveredEventTypes(provider.id, expected)).toEqual(
      expect.arrayContaining(expected)
    );
  });

  it("refuses to deactivate with an SSO-only domain, then allows it", async () => {
    const provider = await newProvider();
    const domain = await (
      await postDomain(adminToken, provider.id, {
        domain: `sso-${generateUniqueId().toLowerCase()}.com`,
        ssoOnly: true,
      })
    ).json();

    const refused = await call(
      writeToken,
      "POST",
      `/${provider.id}/deactivate`
    );
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("sso_only_domain");

    await call(adminToken, "PATCH", `/${provider.id}/domains/${domain.id}`, {
      ssoOnly: false,
    });
    const ok = await call(writeToken, "POST", `/${provider.id}/deactivate`);
    expect(ok.status).toBe(200);

    expect(
      await deliveredEventTypes(provider.id, [
        "auth.identity-provider.deactivated",
      ])
    ).toContain("auth.identity-provider.deactivated");
  });
});
