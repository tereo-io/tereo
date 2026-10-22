// @module-tag int
// @module-tag provisioning
import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { provisionService } from "../../../../../support/provisioning.js";
import { CORE_SERVICE_ID } from "../../../../../../definitions/index.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../../support/coreUrl.js";
import { fetchJson } from "../../../../../support/http.js";
import { describe, it, expect, beforeAll } from "vitest";
import { randomBytes } from "crypto";

const ROOT = CORE_URL;

let adminToken: string;

const rand = () => `x${randomBytes(5).toString("hex")}`;

const api = (
  method: string,
  path: string,
  token: string | null,
  body?: unknown
) => fetchJson(method, `${ROOT}${path}`, token, body);

interface Credentials {
  clientId: string;
  clientSecret: string;
}

interface AddedService {
  id: string;
  slug: string;
  namespace: string;
  credentials: Credentials;
}

const addService = async (
  overrides: { name?: string; slug?: string; namespace?: string } = {}
): Promise<AddedService> => {
  const id = rand();
  const res = await api("POST", "/v1/admin/services", adminToken, {
    name: `Svc ${id}`,
    slug: `svc-${id}-service`,
    ...overrides,
  });
  // The body says which conflict, should this ever answer 409 again.
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
};

const fetchToken = async ({ clientId, clientSecret }: Credentials) => {
  const response = await fetch(`${ROOT}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = (await response.json()) as { access_token?: string };
  return { status: response.status, token: body.access_token ?? null };
};

const accessOf = async (serviceId: string) =>
  prisma.serviceAccess.findMany({
    where: { serviceId },
    orderBy: [{ kind: "asc" }, { target: "asc" }],
  });

const decide = (
  serviceId: string,
  verb: "approve" | "revoke",
  ids: string[],
  token = adminToken
) =>
  api("POST", `/v1/admin/services/${serviceId}/access/${verb}`, token, {
    ids,
  });

beforeAll(async () => {
  adminToken = await getTestPrincipalToken({
    permissions: [
      "services.read",
      "services.write",
      "services.approve",
      "roles.read",
      "roles.write",
      // What the roles approved below grant: an approver grants only what
      // they hold.
      "webhooks.emit",
      "file-service.buckets.read",
      "file-service.objects.delete",
    ],
  });
});

describe("/v1/admin/services/:id", () => {
  describe("approving revoked access again", () => {
    /** A provisioned service whose access to `roles` an admin revoked. */
    const revokedAccess = async (roles: string[]) => {
      const service = await provisionService({ access: { roles } });
      const ids = (await accessOf(service.id)).map((a) => a.id);
      expect((await decide(service.id, "revoke", ids)).status).toBe(200);
      return { service, ids };
    };

    const accountRoles = async (serviceId: string) => {
      const service = await prisma.service.findUniqueOrThrow({
        where: { id: serviceId },
        select: { client: { select: { serviceAccountUser: true } } },
      });
      const userId = service.client!.serviceAccountUser!.id;
      return {
        userId,
        roles: await prisma.userRole.findMany({
          where: { userId },
          select: { role: { select: { name: true } } },
        }),
      };
    };

    it("refuses a role granting what the approver does not hold", async () => {
      const approver = await getTestPrincipalToken({
        permissions: ["services.approve"],
      });
      const { service, ids } = await revokedAccess(["webhook_publisher"]);

      const res = await decide(service.id, "approve", ids, approver);
      expect(res.status).toBe(403);
      expect(res.body.error_description).toContain("webhooks.emit");

      const access = await accessOf(service.id);
      expect(access.map((a) => a.status)).toEqual(["revoked"]);
      expect((await accountRoles(service.id)).roles).toEqual([]);
    });

    it("approves a role whose permissions the approver holds", async () => {
      const approver = await getTestPrincipalToken({
        permissions: ["services.approve", "webhooks.emit"],
      });
      const { service, ids } = await revokedAccess(["webhook_publisher"]);

      const res = await decide(service.id, "approve", ids, approver);
      expect(res.status).toBe(200);
      expect((await accountRoles(service.id)).roles).toEqual([
        { role: { name: "webhook_publisher" } },
      ]);
    });

    it("does not check a role the account already holds", async () => {
      const approver = await getTestPrincipalToken({
        permissions: ["services.approve"],
      });
      const { service, ids } = await revokedAccess(["webhook_publisher"]);
      const { userId } = await accountRoles(service.id);
      const role = await prisma.role.findFirstOrThrow({
        where: { name: "webhook_publisher", serviceId: CORE_SERVICE_ID },
      });
      await prisma.userRole.create({ data: { userId, roleId: role.id } });

      const res = await decide(service.id, "approve", ids, approver);
      expect(res.status).toBe(200);
    });
  });

  describe("secrets", () => {
    it("refuses a secret change to a caller not holding what the service holds", async () => {
      const service = await addService();
      const account = await prisma.user.findFirstOrThrow({
        where: { oauthClient: { clientId: service.credentials.clientId } },
      });
      const publisher = await prisma.role.findFirstOrThrow({
        where: { name: "webhook_publisher", serviceId: CORE_SERVICE_ID },
      });
      await prisma.userRole.create({
        data: { userId: account.id, roleId: publisher.id },
      });
      const writer = await getTestPrincipalToken({
        permissions: ["services.read", "services.write"],
      });

      for (const action of ["regenerate-secret", "revoke-previous-secret"]) {
        const res = await api(
          "POST",
          `/v1/admin/services/${service.id}/${action}`,
          writer
        );
        expect(res.status, action).toBe(403);
        expect(res.body.error_description).toContain("webhooks.emit");
      }
      expect((await fetchToken(service.credentials)).status).toBe(200);

      const regenerated = await api(
        "POST",
        `/v1/admin/services/${service.id}/regenerate-secret`,
        adminToken
      );
      expect(regenerated.status).toBe(200);
    });
  });
});
