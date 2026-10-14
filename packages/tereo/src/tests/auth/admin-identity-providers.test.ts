import { openProviderSecret } from "../../utils/identityProviders/clientSecret.js";
import { createTestRole, generateUniqueId } from "./utils/test-helpers.js";
import { startFakeOidcProvider } from "../utils/fakeOidcProvider.js";
import type { FakeOidcProvider } from "../utils/fakeOidcProvider.js";
import { DEFAULT_ORGANIZATION_ID } from "../../definitions/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mapUniqueViolation } from "../../utils/prismaErrors.js";
import { ensurePermission } from "../utils/testService.js";
import { prisma } from "../../utils/db/prisma.js";
import { CORE_URL } from "../utils/coreUrl.js";
import { randomUUID } from "node:crypto";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../webhooks/utils/test-helpers.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../utils/principals.js";

declare global {
  interface Response {
    // Test bodies are checked field by field.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json(): Promise<any>;
  }
}

const BASE = `${CORE_URL}/v1/admin/identity-providers`;

describe("Admin identity providers", () => {
  let fake: FakeOidcProvider;
  let writeToken: string;
  let readToken: string;
  let usersReadToken: string;
  let orgId: string;

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

  let eventsEndpointId: string;

  beforeAll(async () => {
    fake = await startFakeOidcProvider();
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      {
        eventTypes: [
          "auth.identity-provider.created",
          "auth.identity-provider.deactivated",
          "auth.identity-provider.activated",
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
    usersReadToken = await getTestPrincipalToken({
      permissions: ["users.read"],
    });
    orgId = await ensureTestOrganization(`idp-org-${generateUniqueId()}`);
  });

  afterAll(async () => {
    await fake.close();
  });

  // The reaper deletes outbox rows once it fans them out, so the deliveries
  // are the durable record of what a provider emitted.
  const deliveredEventTypes = async (
    providerId: string,
    expected: string[]
  ) => {
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

  describe("providers", () => {
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

    it("lets only a global admin turn countsAsMfa on", async () => {
      const provider = await newProvider();
      const refused = await call(writeToken, "PATCH", `/${provider.id}`, {
        countsAsMfa: true,
      });
      expect(refused.status).toBe(403);
      expect((await createProvider({ countsAsMfa: true })).status).toBe(403);

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
      const created = await createProvider({ countsAsMfa: true });
      // createProvider posts with writeToken, which may not set the flag.
      expect(created.status).toBe(403);
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

    it("changes the slug while no identity exists", async () => {
      const provider = await newProvider();
      const slug = `moved-${generateUniqueId().toLowerCase()}`.slice(0, 40);
      const response = await call(writeToken, "PATCH", `/${provider.id}`, {
        slug,
      });
      expect(response.status).toBe(200);
      expect((await response.json()).callbackUrl).toContain(
        `/${slug}/callback`
      );
    });

    it("404s an unknown provider", async () => {
      expect((await call(readToken, "GET", `/${randomUUID()}`)).status).toBe(
        404
      );
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

      const response = await call(
        writeToken,
        "POST",
        `/${provider.id}/activate`
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("provider_unreachable");
      const row = await prisma.identityProvider.findUniqueOrThrow({
        where: { id: provider.id },
      });
      expect(row.isActive).toBe(false);
    });

    it("maps a unique-index violation to the given code", async () => {
      const provider = await newProvider();
      const dup = await prisma.identityProvider.findUniqueOrThrow({
        where: { id: provider.id },
      });
      // The pre-check cannot be interleaved from a test, so provoke the
      // real database error the race would produce.
      const err = await mapUniqueViolation(
        () =>
          prisma.identityProvider.create({
            data: { ...dup, id: randomUUID() },
          }),
        "taken",
        "slug_taken"
      ).catch((e: unknown) => e);
      expect(err).toMatchObject({ statusCode: 409, code: "slug_taken" });
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
  });

  describe("domains", () => {
    let permName: string;
    let roleWithOrgPerm: { id: string };
    let ownerToken: string;

    const makeRole = async (permission: string, orgAssignable: boolean) => {
      const perm = await ensurePermission(permission);
      await prisma.permission.update({
        where: { id: perm.id },
        data: { orgAssignable },
      });
      const role = await createTestRole();
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: perm.id },
      });
      return role;
    };

    beforeAll(async () => {
      permName = `idp.test.p${generateUniqueId().toLowerCase()}`;
      roleWithOrgPerm = await makeRole(permName, true);
      ownerToken = await getTestPrincipalToken({
        permissions: ["identity-providers.write", permName],
      });
    });

    const postDomain = (token: string, providerId: string, body: object) =>
      call(token, "POST", `/${providerId}/domains`, {
        organizationId: orgId,
        autoAccept: false,
        ssoOnly: false,
        roleIds: [],
        ...body,
      });

    it("normalizes the domain and lists it", async () => {
      const provider = await newProvider();
      const name = `acme-${generateUniqueId().toLowerCase()}.com`;
      const response = await postDomain(writeToken, provider.id, {
        domain: `@${name.toUpperCase()}`,
        autoAccept: true,
      });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.domain).toBe(name);
      expect(body.organization.id).toBe(orgId);
      expect(body.autoAccept).toBe(true);

      const list = await (
        await call(readToken, "GET", `/${provider.id}/domains`)
      ).json();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(body.id);
    });

    it("rejects a malformed domain", async () => {
      const provider = await newProvider();
      const response = await postDomain(writeToken, provider.id, {
        domain: "not a domain",
      });
      expect(response.status).toBe(400);
    });

    it("refuses a domain another provider claims", async () => {
      const first = await newProvider();
      const second = await newProvider();
      const name = `taken-${generateUniqueId().toLowerCase()}.com`;
      expect(
        (await postDomain(writeToken, first.id, { domain: name })).status
      ).toBe(201);
      const response = await postDomain(writeToken, second.id, {
        domain: name,
      });
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("domain_taken");
    });

    it("sets default roles the caller may grant", async () => {
      const provider = await newProvider();
      const response = await postDomain(ownerToken, provider.id, {
        domain: `roles-${generateUniqueId().toLowerCase()}.com`,
        roleIds: [roleWithOrgPerm.id],
      });
      expect(response.status).toBe(201);
      expect(
        (await response.json()).roles.map((r: { id: string }) => r.id)
      ).toEqual([roleWithOrgPerm.id]);
    });

    it("refuses a role with a permission that is not org-assignable", async () => {
      const provider = await newProvider();
      const role = await makeRole(
        `idp.test.n${generateUniqueId().toLowerCase()}`,
        false
      );
      const response = await postDomain(writeToken, provider.id, {
        domain: `na-${generateUniqueId().toLowerCase()}.com`,
        roleIds: [role.id],
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("not_org_assignable");
    });

    it("refuses a role granting a permission the caller lacks", async () => {
      const provider = await newProvider();
      const response = await postDomain(writeToken, provider.id, {
        domain: `lack-${generateUniqueId().toLowerCase()}.com`,
        roleIds: [roleWithOrgPerm.id],
      });
      expect(response.status).toBe(403);
    });

    it("refuses an unknown role and a system role", async () => {
      const provider = await newProvider();
      const unknown = await postDomain(writeToken, provider.id, {
        domain: `unk-${generateUniqueId().toLowerCase()}.com`,
        roleIds: [randomUUID()],
      });
      expect(unknown.status).toBe(400);
      expect((await unknown.json()).error).toBe("unknown_role");

      const system = await createTestRole({ isSystem: true });
      const response = await postDomain(writeToken, provider.id, {
        domain: `sys-${generateUniqueId().toLowerCase()}.com`,
        roleIds: [system.id],
      });
      expect(response.status).toBe(403);
    });

    it("checks the domain's roles against the organization it moves to", async () => {
      const provider = await newProvider();
      const created = await (
        await postDomain(ownerToken, provider.id, {
          domain: `move-${generateUniqueId().toLowerCase()}.com`,
          roleIds: [roleWithOrgPerm.id],
        })
      ).json();
      const otherOrg = await ensureTestOrganization(
        `idp-move-${generateUniqueId()}`
      );
      const path = `/${provider.id}/domains/${created.id}`;

      // The caller could not grant the role there: moving it is a new grant.
      const moved = await call(writeToken, "PATCH", path, {
        organizationId: otherOrg,
      });
      expect(moved.status).toBe(403);
      const after = await (await call(readToken, "GET", path)).json();
      expect(after.organization.id).toBe(orgId);

      // Without the move, the role the domain already hands out stays.
      const kept = await call(writeToken, "PATCH", path, {
        organizationId: orgId,
        autoAccept: true,
      });
      expect(kept.status).toBe(200);
    });

    it("updates and deletes a domain", async () => {
      const provider = await newProvider();
      const created = await (
        await postDomain(ownerToken, provider.id, {
          domain: `upd-${generateUniqueId().toLowerCase()}.com`,
          roleIds: [roleWithOrgPerm.id],
        })
      ).json();

      const patched = await call(
        writeToken,
        "PATCH",
        `/${provider.id}/domains/${created.id}`,
        { autoAccept: true, roleIds: [] }
      );
      expect(patched.status).toBe(200);
      const body = await patched.json();
      expect(body.autoAccept).toBe(true);
      expect(body.roles).toEqual([]);

      const removed = await call(
        writeToken,
        "DELETE",
        `/${provider.id}/domains/${created.id}`
      );
      expect(removed.status).toBe(204);
      const gone = await call(
        readToken,
        "GET",
        `/${provider.id}/domains/${created.id}`
      );
      expect(gone.status).toBe(404);
    });

    it("keeps fields a domain PATCH does not send", async () => {
      const provider = await newProvider();
      const name = `keep-${generateUniqueId().toLowerCase()}.com`;
      const created = await (
        await postDomain(ownerToken, provider.id, {
          domain: name,
          autoAccept: true,
          roleIds: [roleWithOrgPerm.id],
        })
      ).json();
      const path = `/${provider.id}/domains/${created.id}`;

      const first = await (
        await call(writeToken, "PATCH", path, { ssoOnly: true })
      ).json();
      expect(first.ssoOnly).toBe(true);
      expect(first.autoAccept).toBe(true);
      expect(first.roles.map((r: { id: string }) => r.id)).toEqual([
        roleWithOrgPerm.id,
      ]);

      const renamed = `kept-${generateUniqueId().toLowerCase()}.com`;
      const second = await (
        await call(writeToken, "PATCH", path, { domain: renamed })
      ).json();
      expect(second.domain).toBe(renamed);
      expect(second.ssoOnly).toBe(true);
      expect(second.autoAccept).toBe(true);
      expect(second.roles).toHaveLength(1);
    });

    it("audits a domain PATCH with what it changed", async () => {
      const provider = await newProvider();
      const created = await (
        await postDomain(ownerToken, provider.id, {
          domain: `aud-${generateUniqueId().toLowerCase()}.com`,
          roleIds: [roleWithOrgPerm.id],
        })
      ).json();
      const renamed = `audr-${generateUniqueId().toLowerCase()}.com`;
      const patched = await call(
        writeToken,
        "PATCH",
        `/${provider.id}/domains/${created.id}`,
        { domain: renamed, ssoOnly: true, roleIds: [] }
      );
      expect(patched.status).toBe(200);

      const entry = await prisma.auditLogEntry.findFirstOrThrow({
        where: {
          entityId: created.id,
          entityType: "IdentityProviderDomain",
          action: "UPDATE",
        },
      });
      expect(entry.entityName).toBe(renamed);
      const changes = entry.changes as Record<
        string,
        { old: unknown; new: unknown }
      >;
      expect(changes.ssoOnly).toEqual({ old: false, new: true });
      expect(changes.domain.new).toBe(renamed);
      expect(changes.roles.new).toEqual([]);
      expect((changes.roles.old as { id: string }[]).map((r) => r.id)).toEqual([
        roleWithOrgPerm.id,
      ]);
    });

    it("drops a deleted role from the domains that hand it out", async () => {
      const provider = await newProvider();
      const role = await makeRole(permName, true);
      const created = await (
        await postDomain(ownerToken, provider.id, {
          domain: `delrole-${generateUniqueId().toLowerCase()}.com`,
          roleIds: [role.id, roleWithOrgPerm.id],
        })
      ).json();
      const rolesToken = await getTestPrincipalToken({
        permissions: ["roles.delete", permName],
      });

      const removed = await fetch(`${CORE_URL}/v1/admin/roles/${role.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${rolesToken}` },
      });
      expect(removed.status).toBeGreaterThanOrEqual(200);
      expect(removed.status).toBeLessThan(300);

      const domain = await (
        await call(readToken, "GET", `/${provider.id}/domains/${created.id}`)
      ).json();
      expect(domain.roles.map((r: { id: string }) => r.id)).toEqual([
        roleWithOrgPerm.id,
      ]);
    });

    it("refuses SSO-only on a domain of an inactive provider", async () => {
      const provider = await newProvider();
      expect(
        (await call(writeToken, "POST", `/${provider.id}/deactivate`)).status
      ).toBe(200);

      const refused = await postDomain(writeToken, provider.id, {
        domain: `inact-${generateUniqueId().toLowerCase()}.com`,
        ssoOnly: true,
      });
      expect(refused.status).toBe(409);
      expect((await refused.json()).error).toBe("provider_inactive");

      const created = await postDomain(writeToken, provider.id, {
        domain: `inact-${generateUniqueId().toLowerCase()}.com`,
      });
      expect(created.status).toBe(201);
      const path = `/${provider.id}/domains/${(await created.json()).id}`;
      const patched = await call(writeToken, "PATCH", path, { ssoOnly: true });
      expect(patched.status).toBe(409);
      expect((await patched.json()).error).toBe("provider_inactive");
      expect(
        (await call(writeToken, "PATCH", path, { autoAccept: true })).status
      ).toBe(200);
    });

    it("refuses to deactivate with an SSO-only domain, then allows it", async () => {
      const provider = await newProvider();
      const domain = await (
        await postDomain(writeToken, provider.id, {
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

      await call(writeToken, "PATCH", `/${provider.id}/domains/${domain.id}`, {
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

    it("never leaves an SSO-only domain on an inactive provider when deactivation races the domain", async () => {
      for (let i = 0; i < 10; i++) {
        const provider = await newProvider();
        const domain = await (
          await postDomain(writeToken, provider.id, {
            domain: `race-${generateUniqueId().toLowerCase()}.com`,
          })
        ).json();

        const [deactivated, patched] = await Promise.all([
          call(writeToken, "POST", `/${provider.id}/deactivate`),
          call(writeToken, "PATCH", `/${provider.id}/domains/${domain.id}`, {
            ssoOnly: true,
          }),
        ]);
        expect([deactivated.status, patched.status].sort()).toEqual([200, 409]);

        const [p, d] = await Promise.all([
          prisma.identityProvider.findUniqueOrThrow({
            where: { id: provider.id },
          }),
          prisma.identityProviderDomain.findUniqueOrThrow({
            where: { id: domain.id },
          }),
        ]);
        expect(!p.isActive && d.ssoOnly).toBe(false);
      }
    });
  });
});
