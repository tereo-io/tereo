// @module-tag int
// @module-tag auth

import { DEFAULT_ORGANIZATION_ID } from "../../../../../../../../definitions/index.js";
import { ensurePermission } from "../../../../../../../support/testService.js";
import { generateUniqueId } from "../../../../../../../support/auth/crypto.js";
import { createTestRole } from "../../../../../../../support/auth/users.js";
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CORE_URL } from "../../../../../../../support/coreUrl.js";
import {
  startFakeOidcProvider,
  FakeOidcProvider,
} from "../../../../../../../support/fakeOidcProvider.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../../../../../support/principals.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../../../../support/webhooks.js";

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

describe("GET, PATCH and DELETE /v1/admin/identity-providers/:id/domains/:domainId", () => {
  let permName: string;
  let roleWithOrgPerm: { id: string };
  let ownerToken: string;

  beforeAll(async () => {
    permName = `idp.test.p${generateUniqueId().toLowerCase()}`;
    roleWithOrgPerm = await makeRole(permName, true);
    ownerToken = await getTestPrincipalToken({
      permissions: ["identity-providers.write", permName],
    });
  });

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

  const postDomain = (token: string, providerId: string, body: object) =>
    call(token, "POST", `/${providerId}/domains`, {
      organizationId: orgId,
      autoAccept: false,
      ssoOnly: false,
      roleIds: [],
      ...body,
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

    const expected = [
      "auth.identity-provider.domain-created",
      "auth.identity-provider.domain-updated",
      "auth.identity-provider.domain-deleted",
    ];
    expect((await deliveredEventTypes(created.id, expected)).sort()).toEqual(
      expected.sort()
    );
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
      await call(adminToken, "PATCH", path, { ssoOnly: true })
    ).json();
    expect(first.ssoOnly).toBe(true);
    expect(first.autoAccept).toBe(true);
    expect(first.roles.map((r: { id: string }) => r.id)).toEqual([
      roleWithOrgPerm.id,
    ]);

    const renamed = `kept-${generateUniqueId().toLowerCase()}.com`;
    const second = await (
      await call(adminToken, "PATCH", path, { domain: renamed })
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
      adminToken,
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

    const refused = await postDomain(adminToken, provider.id, {
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
    const patched = await call(adminToken, "PATCH", path, { ssoOnly: true });
    expect(patched.status).toBe(409);
    expect((await patched.json()).error).toBe("provider_inactive");
    expect(
      (await call(writeToken, "PATCH", path, { autoAccept: true })).status
    ).toBe(200);
  });
});
