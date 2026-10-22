// @module-tag int
// @module-tag auth
// @module-tag provisioning
import { ensurePermission } from "../../../../../support/testService.js";
import { removeServices } from "../../../../../support/provisioning.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../../support/coreUrl.js";
import { fetchJson } from "../../../../../support/http.js";
import { randomBytes } from "crypto";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../../../support/principals.js";

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

describe("/v1/admin/integrations/:id", () => {
  describe("roles", () => {
    it("refuses a role whose permissions the approver lacks", async () => {
      const created = await createIntegration({ organizationId: orgId });
      const roleId = await customRole(["webhooks.write"]);
      const res = await api(
        "PUT",
        `/v1/admin/integrations/${created.id}/roles`,
        {
          roleIds: [roleId],
        }
      );
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
  });

  describe("audiences", () => {
    it("requires services.approve", async () => {
      const created = await createIntegration();
      const writer = await getTestPrincipalToken({
        permissions: ["integrations.read", "integrations.write"],
      });
      const res = await api(
        "PUT",
        `/v1/admin/integrations/${created.id}/audiences`,
        { slugs: [] },
        writer
      );
      expect(res.status).toBe(403);
      expect(res.body.error_description).toContain("services.approve");
    });
  });

  describe("updating", () => {
    it("refuses a secret change to a caller not holding what the integration holds", async () => {
      const created = await createIntegration();
      const row = await prisma.service.findUniqueOrThrow({
        where: { id: created.id },
        include: { client: { include: { serviceAccountUser: true } } },
      });
      await prisma.userRole.create({
        data: {
          userId: row.client!.serviceAccountUser!.id,
          roleId: await customRole(["users.read"]),
        },
      });
      const before = await prisma.oAuthClient.findUniqueOrThrow({
        where: { clientId: created.credentials.clientId },
      });

      for (const action of ["regenerate-secret", "revoke-previous-secret"]) {
        const res = await api(
          "POST",
          `/v1/admin/integrations/${created.id}/${action}`
        );
        expect(res.status, action).toBe(403);
        expect(res.body.error_description).toContain("users.read");
      }
      const after = await prisma.oAuthClient.findUniqueOrThrow({
        where: { clientId: created.credentials.clientId },
      });
      expect(after.clientSecret).toBe(before.clientSecret);

      const holder = await getTestPrincipalToken({
        permissions: ["integrations.write", "users.read"],
      });
      const res = await api(
        "POST",
        `/v1/admin/integrations/${created.id}/regenerate-secret`,
        undefined,
        holder
      );
      expect(res.status).toBe(200);
    });
  });
});
