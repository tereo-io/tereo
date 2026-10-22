// @module-tag int
// @module-tag provisioning
import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../../support/coreUrl.js";
import { fetchJson } from "../../../../../support/http.js";
import { describe, it, expect, beforeAll } from "vitest";
import env from "../../../../../../env.js";
import { randomBytes } from "crypto";
import {
  provisionServices,
  newSlug,
} from "../../../../../support/provisioning.js";
import {
  CORE_SERVICE_ID,
  SYSTEM_USER_ID,
} from "../../../../../../definitions/index.js";

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

const tokenFor = async (service: { credentials: Credentials }) => {
  const { status, token } = await fetchToken(service.credentials);
  expect(status).toBe(200);
  return token!;
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
  describe("provisioned access", () => {
    it.each(["admin", "core/admin"])(
      "refuses to approve a %s row that slipped onto file",
      async (target) => {
        const service = await addService();
        await tokenFor(service);
        const row = await prisma.serviceAccess.create({
          data: {
            serviceId: service.id,
            kind: "role",
            target,
            status: "revoked",
          },
        });
        const res = await decide(service.id, "approve", [row.id]);
        expect(res.status).toBe(422);
        expect(
          (
            await prisma.serviceAccess.findUniqueOrThrow({
              where: { id: row.id },
            })
          ).status
        ).toBe("revoked");
      }
    );
  });

  describe("services admin API", () => {
    /** A provisioned service with two approved access rows: a role and an audience. */
    const withAccess = async () => {
      const audienceSlug = newSlug();
      const [, service] = await provisionServices([
        { slug: audienceSlug },
        {
          access: { roles: ["webhook_publisher"], audiences: [audienceSlug] },
        },
      ]);
      const access = await accessOf(service.id);
      expect(access).toHaveLength(2);
      return { service, access };
    };

    it("names who decided each access row", async () => {
      const { service, access } = await withAccess();
      await decide(service.id, "revoke", [access[0].id]);
      const row = await prisma.serviceAccess.findUniqueOrThrow({
        where: { id: access[0].id },
        include: { decider: true },
      });
      expect(row.decider).not.toBeNull();
      expect(row.decidedBy).not.toBe(SYSTEM_USER_ID);

      const detail = await api(
        "GET",
        `/v1/admin/services/${service.id}`,
        adminToken
      );
      expect(detail.status).toBe(200);
      const decided = detail.body.access.find(
        (a: { id: string }) => a.id === access[0].id
      );
      expect(decided).toMatchObject({
        decidedBy: row.decider!.id,
        decidedByEmail: row.decider!.email,
        decidedByName: row.decider!.name,
      });
      // Approved by provisioning, as core.
      const provisioned = detail.body.access.find(
        (a: { id: string }) => a.id === access[1].id
      );
      expect(provisioned).toMatchObject({ decidedBy: SYSTEM_USER_ID });

      const listedRow = (
        await api(
          "GET",
          `/v1/admin/services/access?filter[serviceId]=${service.id}`,
          adminToken
        )
      ).body.data.find((a: { id: string }) => a.id === access[0].id);
      expect(listedRow.decidedByEmail).toBe(row.decider!.email);
    });

    it("states the secret overlap and retirement grace period", async () => {
      const service = await addService();
      const detail = await api(
        "GET",
        `/v1/admin/services/${service.id}`,
        adminToken
      );
      expect(detail.status).toBe(200);
      expect(detail.body.settings).toEqual({
        secretOverlapHours: env.SERVICE_SECRET_OVERLAP_HOURS,
        retirementGraceHours: env.REGISTRY_RETIREMENT_GRACE_HOURS,
      });
    });
  });

  describe("secrets", () => {
    it("keeps the previous secret working until it is revoked", async () => {
      const service = await addService();
      const regenerated = await api(
        "POST",
        `/v1/admin/services/${service.id}/regenerate-secret`,
        adminToken
      );
      expect(regenerated.status).toBe(200);
      expect(regenerated.body.previousSecretExpiresAt).not.toBeNull();
      const fresh = {
        clientId: service.credentials.clientId,
        clientSecret: regenerated.body.clientSecret,
      };

      expect((await fetchToken(fresh)).status).toBe(200);
      expect((await fetchToken(service.credentials)).status).toBe(200);

      await api(
        "POST",
        `/v1/admin/services/${service.id}/revoke-previous-secret`,
        adminToken
      );
      expect((await fetchToken(service.credentials)).status).toBe(401);
      expect((await fetchToken(fresh)).status).toBe(200);
    });

    it("retires the secrets a regeneration pushes out and a revoke ends", async () => {
      const service = await addService();
      const row = () =>
        prisma.oAuthClient.findUniqueOrThrow({
          where: { clientId: service.credentials.clientId },
        });
      const first = (await row()).clientSecret;
      for (let i = 0; i < 2; i++) {
        const res = await api(
          "POST",
          `/v1/admin/services/${service.id}/regenerate-secret`,
          adminToken
        );
        expect(res.status).toBe(200);
      }
      const rotated = await row();
      expect(rotated.retiredSecretHashes).toEqual([first]);

      const revoked = await api(
        "POST",
        `/v1/admin/services/${service.id}/revoke-previous-secret`,
        adminToken
      );
      expect(revoked.status).toBe(200);
      expect(JSON.stringify(revoked.body)).not.toContain(first!);
      const after = await row();
      expect(after.previousSecretHash).toBeNull();
      expect(after.retiredSecretHashes).toEqual([
        first,
        rotated.previousSecretHash,
      ]);
    });

    it("reports no overlap, and refuses the previous secret, once it expires", async () => {
      const service = await addService();
      const regenerated = await api(
        "POST",
        `/v1/admin/services/${service.id}/regenerate-secret`,
        adminToken
      );
      expect(regenerated.status).toBe(200);
      const live = await api(
        "GET",
        `/v1/admin/services/${service.id}`,
        adminToken
      );
      expect(live.body.previousSecretExpiresAt).toBe(
        regenerated.body.previousSecretExpiresAt
      );

      await prisma.oAuthClient.update({
        where: { clientId: service.credentials.clientId },
        data: { previousSecretExpiresAt: new Date(Date.now() - 1000) },
      });

      const expired = await api(
        "GET",
        `/v1/admin/services/${service.id}`,
        adminToken
      );
      expect(expired.status).toBe(200);
      expect(expired.body.previousSecretExpiresAt).toBeNull();
      expect((await fetchToken(service.credentials)).status).toBe(401);
      expect(
        (
          await fetchToken({
            clientId: service.credentials.clientId,
            clientSecret: regenerated.body.clientSecret,
          })
        ).status
      ).toBe(200);
    });

    it("stops a deactivated service", async () => {
      const service = await addService();
      const token = await tokenFor(service);
      const res = await api(
        "PATCH",
        `/v1/admin/services/${service.id}`,
        adminToken,
        {
          isActive: false,
        }
      );
      expect(res.status).toBe(200);
      expect((await api("GET", "/v1/files/buckets", token)).status).toBe(401);

      const entry = await prisma.auditLogEntry.findFirstOrThrow({
        where: {
          entityType: "Service",
          entityId: service.id,
          action: "UPDATE",
        },
        orderBy: { createdAt: "desc" },
      });
      expect(entry.metadata).toMatchObject({ accessTokensRevoked: 1 });
    });

    it("keeps a service's client out of /admin/clients", async () => {
      const service = await addService();
      const client = await prisma.oAuthClient.findUniqueOrThrow({
        where: { clientId: service.credentials.clientId },
      });
      const clientsAdmin = await getTestPrincipalToken({
        permissions: [
          "clients.read",
          "clients.write",
          "clients.delete",
          "clients.admin",
        ],
      });
      expect(
        (
          await api(
            "POST",
            `/v1/admin/clients/${client.id}/regenerate-secret`,
            clientsAdmin
          )
        ).status
      ).toBe(409);
    });
  });

  describe("core", () => {
    it("is not managed through /admin/services", async () => {
      expect(
        (
          await api(
            "PATCH",
            `/v1/admin/services/${CORE_SERVICE_ID}`,
            adminToken,
            {
              isActive: false,
            }
          )
        ).status
      ).toBe(403);
    });
  });
});
