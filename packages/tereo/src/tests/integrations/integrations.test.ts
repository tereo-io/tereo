import { removeServices } from "../provisioning/utils/test-helpers.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensurePermission } from "../utils/testService.js";
import { prisma } from "../../utils/db/prisma.js";
import { CORE_URL } from "../utils/coreUrl.js";
import { fetchJson } from "../utils/http.js";
import { randomBytes } from "crypto";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../utils/principals.js";

const createdSlugs: string[] = [];
const createdRoleIds: string[] = [];

let adminToken: string;
let readerToken: string;
let orgId: string;

const rand = () => randomBytes(5).toString("hex");

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({
    permissions: [
      "integrations.read",
      "integrations.write",
      "services.read",
      "services.write",
      "webhooks.read",
    ],
  });
  readerToken = await getTestPrincipalToken({
    permissions: ["services.read"],
  });
  orgId = await ensureTestOrganization("integrations-org");
});

afterAll(async () => {
  await removeServices(createdSlugs);
  await prisma.userRole.deleteMany({
    where: { roleId: { in: createdRoleIds } },
  });
  await prisma.rolePermission.deleteMany({
    where: { roleId: { in: createdRoleIds } },
  });
  await prisma.role.deleteMany({ where: { id: { in: createdRoleIds } } });
});

const api = (
  method: string,
  path: string,
  body?: unknown,
  token = adminToken
) => fetchJson(method, `${CORE_URL}${path}`, token, body);

interface Created {
  id: string;
  slug: string;
  credentials: { clientId: string; clientSecret: string };
}

const createIntegration = async (
  body: { organizationId?: string } = {}
): Promise<Created> => {
  const slug = `int-${rand()}`;
  createdSlugs.push(slug);
  const res = await api("POST", "/v1/admin/integrations", {
    name: `Integration ${slug}`,
    slug,
    ...body,
  });
  expect(res.status).toBe(201);
  return res.body as Created;
};

const tokenResponse = (clientId: string, clientSecret: string) =>
  fetch(`${CORE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

const tokenOf = async ({ credentials }: Created) => {
  const response = await tokenResponse(
    credentials.clientId,
    credentials.clientSecret
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
};

const claimsOf = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as {
    jti: string;
    org_id?: string;
    permissions?: string[];
    aud?: string | string[];
  };

const isRevoked = async (token: string) =>
  (
    await prisma.accessToken.findUniqueOrThrow({
      where: { jti: claimsOf(token).jti },
    })
  ).revokedAt !== null;

/** A custom role granting these permissions. */
const customRole = async (permissions: string[]) => {
  const ids = [];
  for (const name of permissions) ids.push((await ensurePermission(name)).id);
  const role = await prisma.role.create({
    data: {
      name: `int-role-${rand()}`,
      displayName: "Integration test role",
      rolePermissions: {
        create: ids.map((permissionId) => ({ permissionId })),
      },
    },
  });
  createdRoleIds.push(role.id);
  return role.id;
};

describe("creating integrations", () => {
  it("creates an org-bound integration whose tokens carry its organization", async () => {
    const created = await createIntegration({ organizationId: orgId });
    expect(created.credentials.clientSecret).toBeTruthy();
    expect(created).toMatchObject({
      slug: created.slug,
      organizationId: orgId,
      isActive: true,
      provisioned: false,
      roles: [],
      audience: [],
    });

    const claims = claimsOf(await tokenOf(created));
    expect(claims.org_id).toBe(orgId);

    const row = await prisma.service.findUniqueOrThrow({
      where: { id: created.id },
      include: { client: { include: { serviceAccountUser: true } } },
    });
    expect(row.kind).toBe("integration");
    expect(row.namespace).toBeNull();
    expect(row.client!.organizationId).toBe(orgId);
    const member = await prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: orgId,
          userId: row.client!.serviceAccountUser!.id,
        },
      },
    });
    expect(member).not.toBeNull();
  });

  it("creates a platform integration whose tokens carry no organization", async () => {
    const created = await createIntegration();
    expect(created).toMatchObject({ organizationId: null });
    expect(claimsOf(await tokenOf(created)).org_id).toBeUndefined();
  });

  it("shows the secret only once", async () => {
    const created = await createIntegration();
    const res = await api("GET", `/v1/admin/integrations/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.credentials).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(
      created.credentials.clientSecret
    );
    expect(res.body.clientId).toBe(created.credentials.clientId);
  });

  it("refuses an organization that does not exist", async () => {
    const res = await api("POST", "/v1/admin/integrations", {
      name: "Nowhere",
      slug: `int-${rand()}`,
      organizationId: "00000000-0000-7000-8000-00000000dead",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_organization");
  });

  it("requires integrations.read and integrations.write", async () => {
    expect(
      (await api("GET", "/v1/admin/integrations", undefined, readerToken))
        .status
    ).toBe(403);
    expect(
      (
        await api(
          "POST",
          "/v1/admin/integrations",
          { name: "x", slug: `int-${rand()}` },
          readerToken
        )
      ).status
    ).toBe(403);
  });

  it("lists integrations, and services list none of them", async () => {
    const created = await createIntegration();
    const list = await api(
      "GET",
      `/v1/admin/integrations?filter[slug]=${created.slug}&filter[slug_op]=equals`
    );
    expect(list.status).toBe(200);
    expect(list.body.data.map((i: { id: string }) => i.id)).toEqual([
      created.id,
    ]);

    const services = await api(
      "GET",
      `/v1/admin/services?filter[slug]=${created.slug}&filter[slug_op]=equals`
    );
    expect(services.status).toBe(200);
    expect(services.body.data).toEqual([]);
    expect((await api("GET", `/v1/admin/services/${created.id}`)).status).toBe(
      404
    );
    expect(
      (await api("PATCH", `/v1/admin/services/${created.id}`, { name: "x" }))
        .status
    ).toBe(404);
  });
});

describe("roles", () => {
  it("refuses an org-bound integration a role with a global-only permission", async () => {
    const created = await createIntegration({ organizationId: orgId });
    const roleId = await customRole(["users.read"]);
    const res = await api("PUT", `/v1/admin/integrations/${created.id}/roles`, {
      roleIds: [roleId],
    });
    expect(res.status).toBe(400);
  });

  it("refuses a role whose permissions the approver lacks", async () => {
    const created = await createIntegration({ organizationId: orgId });
    const roleId = await customRole(["webhooks.write"]);
    const res = await api("PUT", `/v1/admin/integrations/${created.id}/roles`, {
      roleIds: [roleId],
    });
    expect(res.status).toBe(403);

    const platform = await createIntegration();
    const globalRole = await customRole(["users.read"]);
    const refused = await api(
      "PUT",
      `/v1/admin/integrations/${platform.id}/roles`,
      { roleIds: [globalRole] }
    );
    expect(refused.status).toBe(403);
  });

  it("grants org roles to an org-bound integration, in its tokens, revoking the old ones", async () => {
    const created = await createIntegration({ organizationId: orgId });
    const before = await tokenOf(created);
    const roleId = await customRole(["webhooks.read"]);
    const res = await api("PUT", `/v1/admin/integrations/${created.id}/roles`, {
      roleIds: [roleId],
    });
    expect(res.status).toBe(200);
    expect(res.body.roles.map((r: { id: string }) => r.id)).toEqual([roleId]);
    expect(await isRevoked(before)).toBe(true);

    const claims = claimsOf(await tokenOf(created));
    expect(claims.permissions).toContain("webhooks.read");

    const row = await prisma.service.findUniqueOrThrow({
      where: { id: created.id },
      include: { client: { include: { serviceAccountUser: true } } },
    });
    const assignments = await prisma.userRole.findMany({
      where: { userId: row.client!.serviceAccountUser!.id },
    });
    expect(assignments).toEqual([
      expect.objectContaining({ roleId, organizationId: orgId }),
    ]);
  });

  it("refuses a role carrying admin, even to an approver holding it", async () => {
    const created = await createIntegration();
    const roleId = await customRole(["admin"]);
    const granter = await getTestPrincipalToken({
      permissions: ["integrations.write", "admin"],
    });
    const res = await api(
      "PUT",
      `/v1/admin/integrations/${created.id}/roles`,
      { roleIds: [roleId] },
      granter
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("role_not_allowed_for_integration");
    const got = await api("GET", `/v1/admin/integrations/${created.id}`);
    expect(got.body.roles).toEqual([]);
  });

  it("grants global roles to a platform integration", async () => {
    const created = await createIntegration();
    const roleId = await customRole(["users.read"]);
    const granter = await getTestPrincipalToken({
      permissions: ["integrations.write", "users.read"],
    });
    const res = await api(
      "PUT",
      `/v1/admin/integrations/${created.id}/roles`,
      { roleIds: [roleId] },
      granter
    );
    expect(res.status).toBe(200);
    expect(claimsOf(await tokenOf(created)).permissions).toContain(
      "users.read"
    );
    const got = await api("GET", `/v1/admin/integrations/${created.id}`);
    expect(got.body.roles).toEqual([
      expect.objectContaining({
        id: roleId,
        displayName: "Integration test role",
      }),
    ]);
  });
});

describe("organization member routes", () => {
  it("leave an integration's membership and org roles alone", async () => {
    const created = await createIntegration({ organizationId: orgId });
    const userId = (await api("GET", `/v1/admin/integrations/${created.id}`))
      .body.serviceAccountUserId as string;
    const orgAdmin = await getTestPrincipalToken({
      permissions: [
        "organizations.read",
        "organizations.write",
        "webhooks.read",
      ],
    });
    const base = `/v1/admin/organizations/${orgId}/members/${userId}`;
    for (const [method, path, body] of [
      ["PUT", "/roles", { roleIds: [] }],
      ["PATCH", "", { memberRole: "admin" }],
      ["DELETE", "", undefined],
    ] as const) {
      const res = await api(method, `${base}${path}`, body, orgAdmin);
      expect(res.status).toBe(403);
    }
  });
});

describe("other admin routes", () => {
  it("point an integration's account and client to /admin/integrations", async () => {
    const created = await createIntegration();
    const row = await prisma.service.findUniqueOrThrow({
      where: { id: created.id },
      include: { client: { include: { serviceAccountUser: true } } },
    });
    const userId = row.client!.serviceAccountUser!.id;
    const roleId = await customRole(["webhooks.read"]);
    const admin = await getTestPrincipalToken({
      permissions: ["users.write", "clients.write", "roles.delete"],
    });
    for (const [method, path, body] of [
      ["PATCH", `/v1/admin/users/${userId}`, { isActive: false }],
      ["DELETE", `/v1/admin/roles/${roleId}/users/${userId}`, undefined],
      ["PATCH", `/v1/admin/clients/${row.clientId}`, { name: "x" }],
    ] as const) {
      const res = await api(method, path, body, admin);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.error_description).toContain("integration");
      expect(res.body.error_description).toContain("/admin/integrations");
    }
  });

  it("names an integration that tries to emit an event", async () => {
    const created = await createIntegration();
    const granter = await getTestPrincipalToken({
      permissions: ["integrations.write", "webhooks.emit"],
    });
    const granted = await api(
      "PUT",
      `/v1/admin/integrations/${created.id}/roles`,
      { roleIds: [await customRole(["webhooks.emit"])] },
      granter
    );
    expect(granted.status).toBe(200);
    const res = await api(
      "POST",
      "/v1/webhooks/events",
      {
        organizationId: orgId,
        eventType: `test.unregistered.${rand()}`,
        entityType: "Item",
        entityId: "item-1",
        data: {},
      },
      await tokenOf(created)
    );
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error_description).toBe(
      `Integration ${created.slug} can't emit events`
    );
  });
});

describe("introspection", () => {
  it("never lets an integration introspect another client's token, even named in its aud", async () => {
    const introspector = await createIntegration();
    const other = await createIntegration();
    const otherRow = await prisma.service.findUniqueOrThrow({
      where: { id: other.id },
    });
    await prisma.oAuthClient.update({
      where: { id: otherRow.clientId! },
      data: { audience: [introspector.slug] },
    });
    const token = await tokenOf(other);
    expect([claimsOf(token).aud].flat()).toContain(introspector.slug);

    const { clientId, clientSecret } = introspector.credentials;
    const res = await fetch(`${CORE_URL}/oauth/introspect`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token }).toString(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false });
  });
});

describe("audiences", () => {
  it("puts the services named in its tokens' aud, and refuses anything else", async () => {
    const serviceSlug = `int-svc-${rand()}`;
    createdSlugs.push(serviceSlug);
    const service = await api("POST", "/v1/admin/services", {
      name: serviceSlug,
      slug: serviceSlug,
    });
    expect(service.status).toBe(201);

    const created = await createIntegration();
    const before = await tokenOf(created);
    const res = await api(
      "PUT",
      `/v1/admin/integrations/${created.id}/audiences`,
      { slugs: [serviceSlug] }
    );
    expect(res.status).toBe(200);
    expect(res.body.audience).toEqual([serviceSlug]);
    expect(await isRevoked(before)).toBe(true);
    expect([claimsOf(await tokenOf(created)).aud].flat()).toContain(
      serviceSlug
    );

    const other = await createIntegration();
    const refused = await api(
      "PUT",
      `/v1/admin/integrations/${created.id}/audiences`,
      { slugs: [other.slug] }
    );
    expect(refused.status).toBe(422);
  });
});

describe("updating", () => {
  it("renames, and deactivation revokes tokens and refuses new ones", async () => {
    const created = await createIntegration({ organizationId: orgId });
    const token = await tokenOf(created);

    const renamed = await api("PATCH", `/v1/admin/integrations/${created.id}`, {
      name: "Renamed",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("Renamed");

    const off = await api("PATCH", `/v1/admin/integrations/${created.id}`, {
      isActive: false,
    });
    expect(off.status).toBe(200);
    expect(off.body.isActive).toBe(false);
    expect(await isRevoked(token)).toBe(true);
    const refused = await tokenResponse(
      created.credentials.clientId,
      created.credentials.clientSecret
    );
    expect(refused.status).not.toBe(200);

    const on = await api("PATCH", `/v1/admin/integrations/${created.id}`, {
      isActive: true,
    });
    expect(on.status).toBe(200);
    await tokenOf(created);
  });

  it("regenerates the secret with an overlap, and ends the overlap", async () => {
    const created = await createIntegration();
    const res = await api(
      "POST",
      `/v1/admin/integrations/${created.id}/regenerate-secret`
    );
    expect(res.status).toBe(200);
    expect(res.body.clientId).toBe(created.credentials.clientId);
    const next = {
      ...created,
      credentials: {
        clientId: created.credentials.clientId,
        clientSecret: res.body.clientSecret as string,
      },
    };
    await tokenOf(created);
    await tokenOf(next);

    const ended = await api(
      "POST",
      `/v1/admin/integrations/${created.id}/revoke-previous-secret`
    );
    expect(ended.status).toBe(200);
    expect(
      (
        await tokenResponse(
          created.credentials.clientId,
          created.credentials.clientSecret
        )
      ).status
    ).toBe(401);
    await tokenOf(next);
  });

  it("does not treat a service as an integration", async () => {
    const serviceSlug = `int-svc-${rand()}`;
    createdSlugs.push(serviceSlug);
    const service = await api("POST", "/v1/admin/services", {
      name: serviceSlug,
      slug: serviceSlug,
    });
    expect(
      (await api("GET", `/v1/admin/integrations/${service.body.id}`)).status
    ).toBe(404);
  });
});

describe("constraints", () => {
  it("refuses a service without a namespace, and a service bound to an organization", async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO "core"."services" ("id", "slug", "name", "kind", "created_by", "updated_at")
        VALUES (gen_random_uuid(), ${`int-raw-${rand()}`}, 'raw', 'service', '00000000-0000-7000-8000-000000000001', now())`
    ).rejects.toThrow(/services_namespace_kind_check/);
    const slug = `int-raw-${rand()}`;
    await expect(
      prisma.$executeRaw`
        INSERT INTO "core"."services" ("id", "slug", "name", "namespace", "kind", "organization_id", "created_by", "updated_at")
        VALUES (gen_random_uuid(), ${slug}, 'raw', ${slug}, 'service', ${orgId}::uuid, '00000000-0000-7000-8000-000000000001', now())`
    ).rejects.toThrow(/services_organization_kind_check/);
  });
});
