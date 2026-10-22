// @module-tag int
// @module-tag auth

import { ensurePermission } from "../../../../../../support/testService.js";
import { generateUniqueId } from "../../../../../../support/auth/crypto.js";
import { createTestRole } from "../../../../../../support/auth/users.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../../../support/coreUrl.js";
import { randomUUID } from "node:crypto";
import {
  startFakeOidcProvider,
  FakeOidcProvider,
} from "../../../../../../support/fakeOidcProvider.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../../../../support/principals.js";

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
let orgId: string;

beforeAll(async () => {
  fake = await startFakeOidcProvider();
  writeToken = await getTestPrincipalToken({
    permissions: ["identity-providers.write"],
  });
  readToken = await getTestPrincipalToken({
    permissions: ["identity-providers.read"],
  });
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

describe("GET and POST /v1/admin/identity-providers/:id/domains", () => {
  let roleWithOrgPerm: { id: string };
  let ownerToken: string;

  beforeAll(async () => {
    const permName = `idp.test.p${generateUniqueId().toLowerCase()}`;
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
    const error = (await response.json()) as {
      error?: string;
      error_description?: string;
    };
    expect(error.error).toBe("invalid_request");
    expect(error.error_description).toMatch(/^Invalid request body\. domain: /);
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
});
