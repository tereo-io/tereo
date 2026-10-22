// @module-tag int
// @module-tag auth

import { getTestPrincipalToken } from "../../support/principals.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { upstreamLogin } from "../../support/upstreamLogin.js";
import { prisma } from "../../../utils/db/prisma.js";
import { randomUUID } from "node:crypto";
import {
  startFakeOidcProvider,
  type FakeOidcProvider,
} from "../../support/fakeOidcProvider.js";
import {
  DEFAULT_ORGANIZATION_ID,
  SYSTEM_USER_ID,
} from "../../../definitions/index.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../support/webhooks.js";
import {
  BASE_URL,
  HTTP_STATUS,
  NON_EXISTENT_UUID,
  createTestClient,
  createTestUser,
  getAccessTokenForUser,
  generateUniqueId,
} from "../../support/auth.js";

interface UserResponse {
  id?: string;
  email?: string;
  name?: string;
  isActive?: boolean;
  password?: string;
  passwordHash?: string;
  [key: string]: unknown;
}

interface ErrorResponse {
  error?: string;
  error_description?: string;
  message?: string;
  [key: string]: unknown;
}

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
