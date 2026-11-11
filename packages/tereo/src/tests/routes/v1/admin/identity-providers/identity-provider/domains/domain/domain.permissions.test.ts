// @module-tag int
// @module-tag auth

import { generateUniqueId } from "../../../../../../../support/auth/crypto.js";
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CORE_URL } from "../../../../../../../support/coreUrl.js";
import { randomUUID } from "node:crypto";
import {
  startFakeOidcProvider,
  FakeOidcProvider,
} from "../../../../../../../support/fakeOidcProvider.js";
import {
  ensureTestMembership,
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../../../../../support/principals.js";

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
let adminToken: string;
let orgId: string;

beforeAll(async () => {
  fake = await startFakeOidcProvider();
  writeToken = await getTestPrincipalToken({
    permissions: ["identity-providers.write", "organizations.write"],
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

describe("PATCH and DELETE /v1/admin/identity-providers/:id/domains/:domainId", () => {
  const postDomain = (token: string, providerId: string, body: object) =>
    call(token, "POST", `/${providerId}/domains`, {
      organizationId: orgId,
      autoAccept: false,
      ssoOnly: false,
      roleIds: [],
      ...body,
    });

  it("turns auto-accept on, or moves an auto-accept domain, only for organizations.write or a caller acting in the organization", async () => {
    const provider = await newProvider();
    const userId = randomUUID();
    const token = await getTestPrincipalToken({
      userId,
      permissions: ["identity-providers.write"],
    });
    const otherOrgId = await ensureTestOrganization(
      `idp-org-${generateUniqueId()}`
    );
    const created = await postDomain(token, provider.id, {
      domain: `aa-${generateUniqueId().toLowerCase()}.com`,
    });
    expect(created.status).toBe(201);
    const path = `/${provider.id}/domains/${(await created.json()).id}`;

    const refused = await call(token, "PATCH", path, { autoAccept: true });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toBe("organization_not_permitted");

    await ensureTestMembership(userId, orgId);
    expect(
      (await call(token, "PATCH", path, { autoAccept: true })).status
    ).toBe(200);

    const moved = await call(token, "PATCH", path, {
      organizationId: otherOrgId,
    });
    expect(moved.status).toBe(403);
    expect((await moved.json()).error).toBe("organization_not_permitted");

    // Already bound: other fields stay editable, and it may leave auto-accept.
    expect((await call(token, "PATCH", path, { roleIds: [] })).status).toBe(
      200
    );
    expect(
      (
        await call(token, "PATCH", path, {
          organizationId: otherOrgId,
          autoAccept: false,
        })
      ).status
    ).toBe(200);
  });

  it("lets only a global admin make a domain SSO-only", async () => {
    const provider = await newProvider();
    const name = `ssoadm-${generateUniqueId().toLowerCase()}.com`;
    const created = await postDomain(writeToken, provider.id, {
      domain: name,
    });
    expect(created.status).toBe(201);
    const path = `/${provider.id}/domains/${(await created.json()).id}`;
    const patched = await call(writeToken, "PATCH", path, { ssoOnly: true });
    expect(patched.status).toBe(403);
    expect((await (await call(readToken, "GET", path)).json()).ssoOnly).toBe(
      false
    );

    const byAdmin = await call(adminToken, "PATCH", path, { ssoOnly: true });
    expect(byAdmin.status).toBe(200);
    expect((await byAdmin.json()).ssoOnly).toBe(true);
  });

  it("lets only a global admin move, lift or delete an SSO-only domain", async () => {
    const provider = await newProvider();
    const created = await postDomain(adminToken, provider.id, {
      domain: `ssomv-${generateUniqueId().toLowerCase()}.com`,
      ssoOnly: true,
    });
    expect(created.status).toBe(201);
    const domain = await created.json();
    const path = `/${provider.id}/domains/${domain.id}`;

    const moved = await call(writeToken, "PATCH", path, {
      domain: `ssomv2-${generateUniqueId().toLowerCase()}.com`,
    });
    expect(moved.status).toBe(403);
    const lifted = await call(writeToken, "PATCH", path, { ssoOnly: false });
    expect(lifted.status).toBe(403);
    const deleted = await call(writeToken, "DELETE", path);
    expect(deleted.status).toBe(403);

    const row = await prisma.identityProviderDomain.findUniqueOrThrow({
      where: { id: domain.id },
    });
    expect(row.domain).toBe(domain.domain);
    expect(row.ssoOnly).toBe(true);

    // What SSO-only does not depend on stays the provider admin's.
    const tweaked = await call(writeToken, "PATCH", path, {
      autoAccept: true,
    });
    expect(tweaked.status).toBe(200);
    const same = await call(writeToken, "PATCH", path, {
      domain: domain.domain,
      ssoOnly: true,
    });
    expect(same.status).toBe(200);

    expect((await call(adminToken, "DELETE", path)).status).toBe(204);
  });
});
