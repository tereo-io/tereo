// @module-tag int
// @module-tag provisioning
import { getTestPrincipalToken } from "../../../../../support/principals.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../../support/coreUrl.js";
import { fetchJson } from "../../../../../support/http.js";
import { describe, it, expect, beforeAll } from "vitest";
import env from "../../../../../../env.js";
import {
  provisionServices,
  addService,
  newSlug,
} from "../../../../../support/provisioning.js";
import {
  CORE_SERVICE_ID,
  DEFAULT_ORGANIZATION_ID,
  SYSTEM_USER_ID,
} from "../../../../../../definitions/index.js";
import {
  clientCredentialsToken,
  tokenFor,
} from "../../../../../support/clientToken.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../../support/webhooks.js";

const ROOT = CORE_URL;

let adminToken: string;

const api = (
  method: string,
  path: string,
  token: string | null,
  body?: unknown
) => fetchJson(method, `${ROOT}${path}`, token, body);

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
        const service = await addService(adminToken);
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
      const service = await addService(adminToken);
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
      const service = await addService(adminToken);
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

      expect((await clientCredentialsToken(fresh)).status).toBe(200);
      expect((await clientCredentialsToken(service.credentials)).status).toBe(
        200
      );

      await api(
        "POST",
        `/v1/admin/services/${service.id}/revoke-previous-secret`,
        adminToken
      );
      expect((await clientCredentialsToken(service.credentials)).status).toBe(
        401
      );
      expect((await clientCredentialsToken(fresh)).status).toBe(200);
    });

    it("retires the secrets a regeneration pushes out and a revoke ends", async () => {
      const service = await addService(adminToken);
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
      const service = await addService(adminToken);
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
      expect((await clientCredentialsToken(service.credentials)).status).toBe(
        401
      );
      expect(
        (
          await clientCredentialsToken({
            clientId: service.credentials.clientId,
            clientSecret: regenerated.body.clientSecret,
          })
        ).status
      ).toBe(200);
    });

    it("stops a deactivated service", async () => {
      const service = await addService(adminToken);
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

  describe("rateLimitPerSecond", () => {
    const patchLimit = (id: string, body: object) =>
      api("PATCH", `/v1/admin/services/${id}`, adminToken, body);
    const getLimit = async (id: string) =>
      (await api("GET", `/v1/admin/services/${id}`, adminToken)).body
        .rateLimitPerSecond;
    const accountOf = (serviceId: string) =>
      prisma.user.findFirstOrThrow({
        where: { oauthClient: { service: { id: serviceId } } },
      });

    it("is set on its own, read back, held by the service account, and cleared with null", async () => {
      const service = await addService(adminToken);
      expect(await getLimit(service.id)).toBeNull();

      const set = await patchLimit(service.id, { rateLimitPerSecond: 50 });
      expect(set.status).toBe(200);
      expect(set.body.rateLimitPerSecond).toBe(50);
      expect(await getLimit(service.id)).toBe(50);
      expect((await accountOf(service.id)).rateLimitPerSecond).toBe(50);

      const cleared = await patchLimit(service.id, {
        rateLimitPerSecond: null,
      });
      expect(cleared.status).toBe(200);
      expect(await getLimit(service.id)).toBeNull();
      expect((await accountOf(service.id)).rateLimitPerSecond).toBeNull();
    });

    it.each([0, 100_001, 1.5, "50"])("refuses %s", async (value) => {
      const service = await addService(adminToken);
      const res = await patchLimit(service.id, { rateLimitPerSecond: value });
      expect(res.status).toBe(400);
      expect(await getLimit(service.id)).toBeNull();
    });

    it("is refused for a provisioned service", async () => {
      const [service] = await provisionServices([{}]);
      const res = await patchLimit(service.id, { rateLimitPerSecond: 50 });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("managed_by_provisioning");
      expect((await accountOf(service.id)).rateLimitPerSecond).toBeNull();
    });

    it("is audited and emitted against the service account, with other fields in the same request", async () => {
      const endpoint = await createTestWebhookEndpoint(
        await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
        { eventTypes: ["auth.user.rate-limit-changed", "core.service.updated"] }
      );
      const service = await addService(adminToken);
      const account = await accountOf(service.id);
      const deliveries = (eventType: string, entityId: string) =>
        prisma.webhookDelivery.findMany({
          where: {
            webhookEndpointId: endpoint.id,
            eventType,
            payload: { path: ["entityId"], equals: entityId },
          },
        });

      const res = await patchLimit(service.id, {
        name: "Renamed",
        rateLimitPerSecond: 40,
      });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Renamed");

      await waitFor(
        async () =>
          (await deliveries("auth.user.rate-limit-changed", account.id))
            .length === 1 &&
          (await deliveries("core.service.updated", service.id)).length === 1,
        10_000
      );
      const [limit] = await deliveries(
        "auth.user.rate-limit-changed",
        account.id
      );
      expect(limit.payload).toMatchObject({
        data: { userId: account.id, rateLimitPerSecond: 40 },
      });
      const [updated] = await deliveries("core.service.updated", service.id);
      expect(JSON.stringify(updated.payload)).not.toContain(
        "rateLimitPerSecond"
      );
      const entry = await prisma.auditLogEntry.findFirstOrThrow({
        where: { entityId: account.id, entityType: "User", action: "UPDATE" },
      });
      expect(entry.metadata).toMatchObject({
        rateLimitPerSecond: { from: null, to: 40 },
      });
    });
  });
});
