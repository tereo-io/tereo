// @module-tag int
// @module-tag provisioning
// @module-tag security
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensurePermission } from "../../support/testService.js";
import { removeServices } from "../../support/provisioning.js";
import { prisma } from "../../../utils/db/prisma.js";
import { CORE_URL } from "../../support/coreUrl.js";
import { fetchJson } from "../../support/http.js";
import { randomBytes } from "crypto";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../support/principals.js";

const createdSlugs: string[] = [];

const createdRoleIds: string[] = [];

let adminToken: string;

let orgId: string;

const rand = () => randomBytes(5).toString("hex");

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
    aud?: string | string[];
  };

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

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({
    permissions: [
      "integrations.read",
      "integrations.write",
      "services.read",
      "services.write",
      "services.approve",
      "webhooks.read",
    ],
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
    // Org-bound: a platform integration's token has no organization to emit
    // for, which is refused before the emit permission is checked.
    const created = await createIntegration({ organizationId: orgId });
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
