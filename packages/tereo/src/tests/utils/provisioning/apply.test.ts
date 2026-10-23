// @module-tag int
// @module-tag provisioning
import { ensureDefaultOrganization } from "../../../utils/defaultOrganization.js";
import { type CustomRoleEntry } from "../../../utils/provisioning/schema.js";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openEndpointSecrets } from "../../../utils/webhookSecrets.js";
import { generateClientSecret } from "../../../utils/crypto.js";
import { retireMissing } from "../../../utils/registry.js";
import { prisma } from "../../../utils/db/prisma.js";
import { CORE_URL } from "../../support/coreUrl.js";
import { logger } from "../../../utils/logger.js";
import { fetchJson } from "../../support/http.js";
import { randomBytes } from "crypto";
import env from "../../../env.js";
import {
  applyProvisioning,
  deprovisionMissing,
} from "../../../utils/provisioning/index.js";
import {
  type LoadedDocument,
  type ProvisioningSet,
  type ResolvedClient,
  type ResolvedService,
  type ResolvedWebhook,
  type ResolvedIntegration,
} from "../../../utils/provisioning/load.js";
import {
  closeCacheBroadcast,
  onBucketInvalidate,
  startCacheSubscriber,
} from "../../../utils/cacheBroadcast.js";
import {
  DEFAULT_ORGANIZATION_ID,
  SYSTEM_USER_ID,
} from "../../../definitions/index.js";
import {
  removeLoginClients,
  removeRoles,
  removeServices,
  newSlug,
  provisionDeclared,
  provisionRand as rand,
  newClientSpec,
  ownerDeclaration,
} from "../../support/provisioning.js";
import {
  clientCredentialsToken,
  serviceToken,
} from "../../support/clientToken.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../support/principals.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../support/webhooks.js";

let adminToken: string;

const createdSlugs: string[] = [];

const createdClientIds: string[] = [];

const clientSpec = (extra: Partial<ResolvedClient> = {}): ResolvedClient => {
  const spec = newClientSpec(extra);
  createdClientIds.push(spec.clientId);
  return spec;
};

const createdRoleNames: string[] = [];

/** Waits for a delivery of `eventType` about `entityId` whose data has `fields`. */
const waitForDelivered = (
  endpointId: string,
  eventType: string,
  entityId: string,
  fields: Record<string, unknown>
) =>
  waitFor(async () => {
    const deliveries = await prisma.webhookDelivery.findMany({
      where: {
        webhookEndpointId: endpointId,
        eventType,
        payload: { path: ["entityId"], equals: entityId },
      },
    });
    return deliveries.some((d) => {
      const { data } = d.payload as { data: Record<string, unknown> };
      return Object.entries(fields).every(([k, v]) => data[k] === v);
    });
  }, 10_000);

const newSecret = () => {
  const { plainSecret, hashedSecret } = generateClientSecret();
  return { plain: plainSecret, hash: hashedSecret };
};

interface ServiceDoc extends LoadedDocument {
  service: ResolvedService;
  plainSecret: string;
}

const serviceDoc = (
  extra: Partial<ResolvedService> = {},
  doc: { file?: string; version?: string } = {}
): ServiceDoc => {
  const slug = extra.slug ?? `prov-${rand()}`;
  createdSlugs.push(slug);
  const secret = newSecret();
  return {
    file: doc.file ?? `${slug}.json`,
    version: doc.version ?? "1.0.0",
    service: {
      slug,
      name: `Service ${slug}`,
      namespace: slug,
      clientId: slug,
      internalHost: null,
      secretEnv: "SERVICE_SECRET",
      secretHash: secret.hash,
      access: { roles: [], audiences: [] },
      permissions: [],
      systemRoles: [],
      buckets: [],
      eventTypes: [],
      webhooks: [],
      ...extra,
    },
    clients: [],
    roles: [],
    plainSecret: secret.plain,
  };
};

/** The document again, its service changed. */
const withService = (
  d: ServiceDoc,
  extra: Partial<ResolvedService>,
  doc: { file?: string; version?: string } = {}
): ServiceDoc => ({ ...d, ...doc, service: { ...d.service, ...extra } });

const clientsDoc = (...clients: ResolvedClient[]): LoadedDocument => ({
  file: "clients.json",
  version: "1.0.0",
  service: null,
  clients,
  roles: [],
});

const setOf = (...docs: LoadedDocument[]): ProvisioningSet => ({
  documents: docs.map(({ file, version, service, clients, roles }) => ({
    file,
    version,
    service,
    clients,
    roles,
  })),
});

const apply = (...docs: LoadedDocument[]) => applyProvisioning(setOf(...docs));

const fetchToken = async (clientId: string, clientSecret: string) =>
  (await clientCredentialsToken({ clientId, clientSecret })).status;

const api = (method: string, path: string, body?: unknown) =>
  fetchJson(method, `${CORE_URL}${path}`, adminToken, body);

const serviceRow = (slug: string) =>
  prisma.service.findUniqueOrThrow({
    where: { slug },
    include: { client: { include: { serviceAccountUser: true } } },
  });

const clientRow = (clientId: string) =>
  prisma.oAuthClient.findUniqueOrThrow({ where: { clientId } });

const auditCount = (entityIds: string[]) =>
  prisma.auditLogEntry.count({ where: { entityId: { in: entityIds } } });

beforeAll(async () => {
  // Events are written in this process, outside the server.
  await ensureDefaultOrganization();
  adminToken = await getTestPrincipalToken({
    permissions: [
      "services.read",
      "services.write",
      "services.approve",
      "clients.read",
      "clients.write",
      "clients.delete",
      "clients.admin",
    ],
  });
});

afterAll(async () => {
  await removeRoles(createdRoleNames);
  await removeServices(createdSlugs);
  await removeLoginClients(createdClientIds);
});

describe("applyProvisioning", () => {
  it("creates a service with its client, service-account user and given secret", async () => {
    const d = serviceDoc();
    const result = await apply(d);
    expect(result.created).toContain(`service:${d.service.slug}`);

    const row = await serviceRow(d.service.slug);
    expect(row.provisioned).toBe(true);
    expect(row.unprovisionedAt).toBeNull();
    expect(row.namespace).toBe(d.service.namespace);
    expect(row.createdBy).toBe(SYSTEM_USER_ID);
    expect(row.client?.clientId).toBe(d.service.clientId);
    expect(row.client?.provisioned).toBe(true);
    expect(row.client?.grantTypes).toEqual(["client_credentials"]);
    expect(row.client?.clientSecret).toBe(d.service.secretHash);
    expect(row.client?.serviceAccountUser?.userType).toBe("service_account");

    expect(await fetchToken(d.service.clientId, d.plainSecret)).toBe(200);
  });

  it("creates a login client with audience and consentRequired", async () => {
    const target = serviceDoc();
    const secret = newSecret();
    const spec = clientSpec({
      clientType: "confidential",
      secretEnv: "APP_SECRET",
      secretHash: secret.hash,
      audience: [target.service.slug],
      consentRequired: false,
    });
    const result = await apply(target, clientsDoc(spec));
    expect(result.created).toEqual(
      expect.arrayContaining([
        `service:${target.service.slug}`,
        `client:${spec.clientId}`,
      ])
    );

    const row = await clientRow(spec.clientId);
    expect(row.provisioned).toBe(true);
    expect(row.ownerId).toBe(SYSTEM_USER_ID);
    expect(row.clientType).toBe("confidential");
    expect(row.clientSecret).toBe(secret.hash);
    expect(row.audience).toEqual([target.service.slug]);
    expect(row.consentRequired).toBe(false);
    expect(row.redirectUris).toEqual(spec.redirectUris);
    expect(row.scopes).toEqual(spec.scopes);
  });

  it("stores trustedCoreScopes, updates them and shows them read-only", async () => {
    const spec = clientSpec({
      scopes: ["openid", "core:files.read", "core:account"],
      consentRequired: false,
      trustedCoreScopes: ["core:files.read"],
    });
    await apply(clientsDoc(spec));
    const row = await clientRow(spec.clientId);
    expect(row.trustedCoreScopes).toEqual(["core:files.read"]);

    const result = await apply(
      clientsDoc({
        ...spec,
        trustedCoreScopes: ["core:files.read", "core:account"],
      })
    );
    expect(result.updated).toEqual([`client:${spec.clientId}`]);
    expect((await clientRow(spec.clientId)).trustedCoreScopes).toEqual([
      "core:account",
      "core:files.read",
    ]);

    const reordered = await apply(
      clientsDoc({
        ...spec,
        trustedCoreScopes: ["core:account", "core:files.read", "core:account"],
      })
    );
    expect(reordered.updated).toEqual([]);

    const read = await api("GET", `/v1/admin/clients/${row.id}`);
    expect(read.status).toBe(200);
    expect(read.body.trustedCoreScopes).toEqual([
      "core:account",
      "core:files.read",
    ]);
  });

  it("is idempotent: a second apply changes nothing and writes no audit entry", async () => {
    const d = serviceDoc();
    Object.assign(d.service, ownerDeclaration(d.service.namespace));
    const client = clientSpec({ audience: [d.service.slug] });
    const set = setOf(d, clientsDoc(client));
    await applyProvisioning(set);
    const ids = [
      (await serviceRow(d.service.slug)).id,
      (await clientRow(client.clientId)).id,
    ];
    const before = await auditCount(ids);
    const updatedAt = (await clientRow(client.clientId)).updatedAt;

    const again = await applyProvisioning(set);
    expect(again).toEqual({
      created: [],
      updated: [],
      rotated: [],
      unprovisioned: [],
      declared: [],
      access: [],
      roles: [],
    });
    expect(await auditCount(ids)).toBe(before);
    expect((await clientRow(client.clientId)).updatedAt).toEqual(updatedAt);
  });

  it("updates a changed name, redirect URIs, audience or consent setting", async () => {
    const d = serviceDoc();
    const other = serviceDoc();
    const client = clientSpec();
    await apply(d, other, clientsDoc(client));

    const result = await apply(
      withService(d, { name: "Renamed service" }),
      other,
      clientsDoc({
        ...client,
        name: "Renamed app",
        redirectUris: ["https://app.example.com/other-callback"],
        audience: [other.service.slug],
        consentRequired: false,
      })
    );
    expect(result.updated.sort()).toEqual(
      [`client:${client.clientId}`, `service:${d.service.slug}`].sort()
    );

    const s = await serviceRow(d.service.slug);
    expect(s.name).toBe("Renamed service");
    expect(s.client?.name).toBe("Renamed service");
    const c = await clientRow(client.clientId);
    expect(c.name).toBe("Renamed app");
    expect(c.redirectUris).toEqual(["https://app.example.com/other-callback"]);
    expect(c.audience).toEqual([other.service.slug]);
    expect(c.consentRequired).toBe(false);
  });

  it("treats a renamed file as the same service", async () => {
    const d = serviceDoc({}, { file: "x.json" });
    await apply(d);
    const result = await apply({ ...d, file: "y.json" });
    expect(result.created).toEqual([]);
  });

  it("rotates a changed secret, keeping the old one for the overlap", async () => {
    const d = serviceDoc();
    await apply(d);
    const next = newSecret();

    const now = new Date();
    const result = await applyProvisioning(
      setOf(withService(d, { secretHash: next.hash })),
      now
    );
    expect(result.rotated).toEqual([`service:${d.service.slug}`]);

    const row = await serviceRow(d.service.slug);
    expect(row.client?.clientSecret).toBe(next.hash);
    expect(row.client?.previousSecretHash).toBe(d.service.secretHash);
    expect(row.client?.previousSecretExpiresAt?.getTime()).toBe(
      now.getTime() + env.SERVICE_SECRET_OVERLAP_HOURS * 60 * 60 * 1000
    );
    expect(await fetchToken(d.service.clientId, d.plainSecret)).toBe(200);
    expect(await fetchToken(d.service.clientId, next.plain)).toBe(200);
  });

  it("marks an entry missing from the set as unprovisioned, and clears it when it returns", async () => {
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["core.service.updated", "auth.client.updated"] }
    );
    const d = serviceDoc();
    const client = clientSpec();
    await apply(d, clientsDoc(client));

    const now = new Date();
    const result = await applyProvisioning(setOf(), now);
    expect(result.unprovisioned).toEqual(
      expect.arrayContaining([
        `service:${d.service.slug}`,
        `client:${client.clientId}`,
      ])
    );
    const s = await serviceRow(d.service.slug);
    const c = await clientRow(client.clientId);
    expect(s.unprovisionedAt).toEqual(now);
    expect(c.unprovisionedAt).toEqual(now);

    // emitTx → core.outbox → reaper → fan-out creates the delivery.
    for (const [eventType, entityId] of [
      ["core.service.updated", s.id],
      ["auth.client.updated", c.id],
    ]) {
      await waitForDelivered(endpoint.id, eventType, entityId, {
        unprovisionedAt: now.toISOString(),
      });
    }

    // A later start without it keeps the first time it went missing.
    await applyProvisioning(setOf(), new Date(now.getTime() + 60_000));
    expect((await serviceRow(d.service.slug)).unprovisionedAt).toEqual(now);

    const back = await apply(d, clientsDoc(client));
    expect(back.updated.sort()).toEqual(
      [`client:${client.clientId}`, `service:${d.service.slug}`].sort()
    );
    expect((await serviceRow(d.service.slug)).unprovisionedAt).toBeNull();
    expect((await clientRow(client.clientId)).unprovisionedAt).toBeNull();
    for (const [eventType, entityId] of [
      ["core.service.updated", s.id],
      ["auth.client.updated", c.id],
    ]) {
      await waitForDelivered(endpoint.id, eventType, entityId, {
        unprovisionedAt: null,
      });
    }
  });

  describe("retirement", () => {
    const HOUR = 60 * 60 * 1000;
    const grace = env.REGISTRY_RETIREMENT_GRACE_HOURS * HOUR;

    const liveTokens = async (clientRowId: string) =>
      prisma.accessToken.count({
        where: { clientId: clientRowId, revokedAt: null },
      });

    it("deactivates a service unprovisioned longer than the grace and revokes its tokens", async () => {
      const d = serviceDoc();
      await apply(d);
      await serviceToken(d);
      const before = await serviceRow(d.service.slug);
      expect(await liveTokens(before.client!.id)).toBeGreaterThan(0);

      const now = new Date();
      await applyProvisioning(setOf(), now);
      const result = await deprovisionMissing(
        new Date(now.getTime() + grace + HOUR)
      );
      expect(result.services).toBeGreaterThanOrEqual(1);

      const row = await serviceRow(d.service.slug);
      expect(row.isActive).toBe(false);
      expect(row.client?.serviceAccountUser?.isActive).toBe(false);
      expect(await liveTokens(row.client!.id)).toBe(0);
      const audit = await prisma.auditLogEntry.findFirst({
        where: { entityId: row.id, action: "UPDATE" },
        orderBy: { createdAt: "desc" },
      });
      expect(audit?.userId).toBe(SYSTEM_USER_ID);
    });

    it("deletes a login client unprovisioned longer than the grace", async () => {
      const client = clientSpec();
      await apply(clientsDoc(client));
      const id = (await clientRow(client.clientId)).id;

      const now = new Date();
      await applyProvisioning(setOf(), now);
      const result = await deprovisionMissing(
        new Date(now.getTime() + grace + HOUR)
      );
      expect(result.clients).toBeGreaterThanOrEqual(1);

      expect(
        await prisma.oAuthClient.findUnique({
          where: { clientId: client.clientId },
        })
      ).toBeNull();
      const audit = await prisma.auditLogEntry.findFirst({
        where: { entityId: id, action: "DELETE" },
      });
      expect(audit?.userId).toBe(SYSTEM_USER_ID);

      // Nothing of it is left to conflict with the entry returning.
      const back = await apply(clientsDoc(client));
      expect(back.created).toContain(`client:${client.clientId}`);
    });

    it("lets a deactivated service's buckets be deleted, and declares them again on its return", async () => {
      const slug = `prov-${rand()}`;
      const bucketName = `${slug}-files`;
      const d = serviceDoc({
        slug,
        buckets: [{ bucketName, policy: "private" }],
      });
      await apply(d);
      const token = await getTestPrincipalToken({
        permissions: ["file-service.admin", "file-service.buckets.delete"],
      });
      const del = () =>
        fetchJson(
          "DELETE",
          `${CORE_URL}/v1/files/buckets/${bucketName}`,
          token
        );
      const refused = await del();
      expect(refused.status).toBe(409);

      const now = new Date();
      await applyProvisioning(setOf(), now);
      const later = new Date(now.getTime() + grace + HOUR);
      await deprovisionMissing(later);
      const bucket = await prisma.bucket.findFirstOrThrow({
        where: { name: bucketName, deletedAt: null },
      });
      expect(bucket.missingSince).toEqual(later);

      // Returning, it declares the bucket again.
      await apply(d);
      expect(
        (await prisma.bucket.findUniqueOrThrow({ where: { id: bucket.id } }))
          .missingSince
      ).toBeNull();
      expect((await del()).status).toBe(409);

      await applyProvisioning(setOf(), now);
      await deprovisionMissing(later);
      expect((await del()).status).toBe(204);
      expect(
        (await prisma.bucket.findUniqueOrThrow({ where: { id: bucket.id } }))
          .deletedAt
      ).not.toBeNull();
    });

    it("leaves entries inside the grace untouched", async () => {
      const d = serviceDoc();
      const client = clientSpec();
      await apply(d, clientsDoc(client));
      await serviceToken(d);

      const now = new Date();
      await applyProvisioning(setOf(), now);
      await deprovisionMissing(new Date(now.getTime() + grace - HOUR));

      const row = await serviceRow(d.service.slug);
      expect(row.isActive).toBe(true);
      expect(await liveTokens(row.client!.id)).toBeGreaterThan(0);
      await clientRow(client.clientId);
    });

    it("reactivates a deactivated service when it returns to the set", async () => {
      const d = serviceDoc();
      await apply(d);
      const now = new Date();
      await applyProvisioning(setOf(), now);
      await deprovisionMissing(new Date(now.getTime() + grace + HOUR));
      expect((await serviceRow(d.service.slug)).isActive).toBe(false);

      const back = await apply(d);
      expect(back.updated).toContain(`service:${d.service.slug}`);
      const row = await serviceRow(d.service.slug);
      expect(row.isActive).toBe(true);
      expect(row.unprovisionedAt).toBeNull();
      expect(row.client?.serviceAccountUser?.isActive).toBe(true);
      expect(await fetchToken(d.service.clientId, d.plainSecret)).toBe(200);
      const reactivated = await prisma.auditLogEntry.findFirst({
        where: {
          entityId: row.id,
          changes: { path: ["isActive", "new"], equals: true },
        },
      });
      expect(reactivated?.userId).toBe(SYSTEM_USER_ID);
      expect(reactivated?.metadata).toMatchObject({
        file: d.file,
        version: d.version,
      });
    });
  });

  describe("bucket cache invalidation", () => {
    const seen = new Set<string>();
    beforeAll(async () => {
      await startCacheSubscriber();
      onBucketInvalidate((name) => seen.add(name));
    });
    afterAll(async () => {
      await closeCacheBroadcast();
    });
    const invalidated = (name: string) =>
      waitFor(async () => seen.has(name), 5_000);

    it("is broadcast for buckets declared, dropped and retired", async () => {
      const slug = `prov-${rand()}`;
      const kept = `${slug}-kept`;
      const dropped = `${slug}-dropped`;
      const d = serviceDoc({
        slug,
        buckets: [
          { bucketName: kept, policy: "private" },
          { bucketName: dropped, policy: "private" },
        ],
      });
      await apply(d);
      await invalidated(kept);
      await invalidated(dropped);

      seen.clear();
      await apply(
        withService(
          d,
          { buckets: [{ bucketName: kept, policy: "private" }] },
          { version: "1.1.0" }
        )
      );
      await invalidated(dropped);

      seen.clear();
      const retired = await retireMissing(
        new Date(
          Date.now() + (env.REGISTRY_RETIREMENT_GRACE_HOURS + 1) * 3_600_000
        )
      );
      expect(retired.retiredBuckets).toContain(dropped);
      await invalidated(dropped);
    });
  });

  describe("declarations", () => {
    const declaredEntries = (serviceId: string) =>
      prisma.auditLogEntry.findMany({
        where: {
          entityId: serviceId,
          metadata: { path: ["via"], equals: "declaration" },
        },
      });

    it("applies a service's declaration with the document's version", async () => {
      const d = serviceDoc({}, { version: "1.4.0" });
      Object.assign(d.service, ownerDeclaration(d.service.namespace));
      const result = await apply(d);
      expect(result.declared).toEqual([`service:${d.service.slug}`]);

      const row = await serviceRow(d.service.slug);
      expect(row.declarationVersion).toBe("1.4.0");
      expect(row.declarationHash).not.toBeNull();
      const permission = await prisma.permission.findUniqueOrThrow({
        where: { name: `${d.service.namespace}.items.read` },
      });
      expect(permission.serviceId).toBe(row.id);
      const role = await prisma.role.findUniqueOrThrow({
        where: {
          serviceId_name: {
            serviceId: row.id,
            name: `${d.service.namespace}_item_reader`,
          },
        },
        include: { rolePermissions: true },
      });
      expect(role.rolePermissions.map((rp) => rp.permissionId)).toEqual([
        permission.id,
      ]);

      const [entry] = await declaredEntries(row.id);
      expect(entry.userId).toBe(SYSTEM_USER_ID);
      expect(entry.metadata).toMatchObject({ file: d.file, version: "1.4.0" });
    });

    it("skips an unchanged declaration", async () => {
      const d = serviceDoc();
      Object.assign(d.service, ownerDeclaration(d.service.namespace));
      await apply(d);
      const id = (await serviceRow(d.service.slug)).id;
      const before = await auditCount([id]);

      const again = await apply(d);
      expect(again.declared).toEqual([]);
      expect(await auditCount([id])).toBe(before);
      expect(await declaredEntries(id)).toHaveLength(1);
    });

    it("applies a lower version, with a warning", async () => {
      const d = serviceDoc({}, { version: "1.1.0" });
      Object.assign(d.service, ownerDeclaration(d.service.namespace));
      await apply(d);

      const warn = vi.spyOn(logger, "warn");
      try {
        const rollback = withService(
          d,
          ownerDeclaration(d.service.namespace, ["read", "write"]),
          { version: "1.0.0" }
        );
        const result = await apply(rollback);
        expect(result.declared).toEqual([`service:${d.service.slug}`]);
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            storedVersion: "1.1.0",
            appliedVersion: "1.0.0",
          }),
          "Applied a declaration older than the one applied before"
        );
      } finally {
        warn.mockRestore();
      }
      expect((await serviceRow(d.service.slug)).declarationVersion).toBe(
        "1.0.0"
      );
    });
  });

  describe("a provisioned service's declaration", () => {
    it("is applied under the service", async () => {
      const service = await provisionDeclared();
      const permission = await prisma.permission.findUniqueOrThrow({
        where: { name: `${service.namespace}.items.read` },
      });
      expect(permission.serviceId).toBe(service.id);
      const role = await prisma.role.findFirstOrThrow({
        where: {
          serviceId: service.id,
          name: `${service.namespace}_item_reader`,
        },
        include: { rolePermissions: true },
      });
      expect(role.rolePermissions).toHaveLength(1);
      const eventType = await prisma.eventType.findUniqueOrThrow({
        where: { eventType: `${service.namespace}.item.created` },
      });
      expect(eventType.source).toBe(service.slug);
    });

    it("stores an event type's read permission, its own or core's", async () => {
      const slug = newSlug();
      const ns = slug;
      const service = await provisionDeclared(
        {
          eventTypes: [
            {
              eventType: `${ns}.item.created`,
              readPermission: `${ns}.items.read`,
            },
            { eventType: `${ns}.user.linked`, readPermission: "users.read" },
            { eventType: `${ns}.item.pinged` },
          ],
        },
        { slug }
      );
      const rows = await prisma.eventType.findMany({
        where: { serviceId: service.id },
        orderBy: { eventType: "asc" },
      });
      expect(rows.map((r) => [r.eventType, r.readPermission])).toEqual([
        [`${ns}.item.created`, `${ns}.items.read`],
        [`${ns}.item.pinged`, null],
        [`${ns}.user.linked`, "users.read"],
      ]);
    });
  });

  describe("org-assignable permissions", () => {
    it("stores the flag a declaration gives, false when it gives none", async () => {
      const slug = newSlug();
      const ns = slug;
      await provisionDeclared(
        {
          permissions: [
            {
              name: `${ns}.items.read`,
              displayName: "Read",
              orgAssignable: true,
            },
            { name: `${ns}.items.write`, displayName: "Write" },
          ],
        },
        { slug }
      );
      const service = await prisma.service.findUniqueOrThrow({
        where: { slug },
      });

      const flags = await prisma.permission.findMany({
        where: { serviceId: service.id },
        select: { name: true, orgAssignable: true },
        orderBy: { name: "asc" },
      });
      expect(flags).toEqual([
        { name: `${ns}.items.read`, orgAssignable: true },
        { name: `${ns}.items.write`, orgAssignable: false },
      ]);

      // Changing only the flag is a change.
      await provisionDeclared(
        {
          permissions: [
            { name: `${ns}.items.read`, displayName: "Read" },
            { name: `${ns}.items.write`, displayName: "Write" },
          ],
        },
        { slug }
      );
      expect(
        (
          await prisma.permission.findUniqueOrThrow({
            where: { name: `${ns}.items.read` },
          })
        ).orgAssignable
      ).toBe(false);
    });
  });

  describe("custom roles", () => {
    const roleSpec = (
      permissions: string[],
      extra: Partial<CustomRoleEntry> = {}
    ): CustomRoleEntry => {
      const name = extra.name ?? `prov-role-${rand()}`;
      createdRoleNames.push(name);
      return {
        name,
        displayName: `Role ${name}`,
        orgAssignable: false,
        requires2fa: false,
        permissions,
        ...extra,
      };
    };

    const rolesDoc = (...roles: CustomRoleEntry[]): LoadedDocument => ({
      file: "roles.json",
      version: "1.0.0",
      service: null,
      clients: [],
      roles,
    });

    const roleRow = (name: string) =>
      prisma.role.findFirstOrThrow({
        where: { name, serviceId: null },
        include: { rolePermissions: { include: { permission: true } } },
      });

    const permissionsOf = async (name: string) =>
      (await roleRow(name)).rolePermissions
        .map((rp) => rp.permission.name)
        .sort();

    const ownerDoc = () => {
      const ns = `prov-${rand()}`;
      return serviceDoc({ slug: ns, namespace: ns, ...ownerDeclaration(ns) });
    };

    it("creates a custom role over core and service permissions", async () => {
      const owner = ownerDoc();
      const ns = owner.service.namespace;
      const role = roleSpec(["roles.read", `${ns}.items.read`]);
      const result = await apply(owner, rolesDoc(role));
      expect(result.roles).toEqual([`role:${role.name}`]);

      const row = await roleRow(role.name);
      expect(row.serviceId).toBeNull();
      expect(row.provisioned).toBe(true);
      expect(row.displayName).toBe(role.displayName);
      expect(await permissionsOf(role.name)).toEqual(
        ["roles.read", `${ns}.items.read`].sort()
      );
      const audit = await prisma.auditLogEntry.findFirst({
        where: { entityId: row.id, action: "CREATE" },
      });
      expect(audit?.userId).toBe(SYSTEM_USER_ID);
      expect(audit?.metadata).toMatchObject({
        file: "roles.json",
        version: "1.0.0",
      });
    });

    it("replaces a custom role's permissions, auditing it once", async () => {
      const owner = ownerDoc();
      const ns = owner.service.namespace;
      const role = roleSpec(["roles.read"]);
      await apply(owner, rolesDoc(role));
      const row = await roleRow(role.name);

      const grown = {
        ...role,
        permissions: [`${ns}.items.write`],
        description: "d",
      };
      const result = await apply(owner, rolesDoc(grown));
      expect(result.roles).toEqual([`role:${role.name}`]);
      expect(await permissionsOf(role.name)).toEqual([`${ns}.items.write`]);
      expect((await roleRow(role.name)).description).toBe("d");
      const updates = () =>
        prisma.auditLogEntry.count({
          where: { entityId: row.id, action: "UPDATE" },
        });
      expect(await updates()).toBe(1);

      const again = await apply(owner, rolesDoc(grown));
      expect(again.roles).toEqual([]);
      expect(await updates()).toBe(1);
    });

    it("applies requires2fa on create and on update", async () => {
      const role = roleSpec(["roles.read"], { requires2fa: true });
      await apply(rolesDoc(role));
      expect((await roleRow(role.name)).requires2fa).toBe(true);

      const result = await apply(rolesDoc({ ...role, requires2fa: false }));
      expect(result.roles).toEqual([`role:${role.name}`]);
      expect((await roleRow(role.name)).requires2fa).toBe(false);
    });

    it("reactivates a provisioned role left inactive when the set lists it", async () => {
      const role = roleSpec(["roles.read"]);
      await apply(rolesDoc(role));
      await prisma.role.update({
        where: { id: (await roleRow(role.name)).id },
        data: { isActive: false },
      });
      const result = await apply(rolesDoc(role));
      expect(result.roles).toEqual([`role:${role.name}`]);
      expect((await roleRow(role.name)).isActive).toBe(true);
    });

    describe("retirement", () => {
      const HOUR = 60 * 60 * 1000;
      const grace = env.REGISTRY_RETIREMENT_GRACE_HOURS * HOUR;

      it("archives a role missing from the set after the grace, and restores it when it returns", async () => {
        const role = roleSpec(["roles.read"]);
        await apply(rolesDoc(role));

        const now = new Date();
        const result = await applyProvisioning(setOf(), now);
        expect(result.unprovisioned).toContain(`role:${role.name}`);
        expect((await roleRow(role.name)).unprovisionedAt).toEqual(now);

        const early = await deprovisionMissing(
          new Date(now.getTime() + grace - HOUR)
        );
        expect(early.roles).toBe(0);
        expect((await roleRow(role.name)).archivedAt).toBeNull();

        const late = await deprovisionMissing(
          new Date(now.getTime() + grace + HOUR)
        );
        expect(late.roles).toBeGreaterThanOrEqual(1);
        const archived = await roleRow(role.name);
        expect(archived.archivedAt).not.toBeNull();
        expect(archived.isActive).toBe(false);

        const back = await apply(rolesDoc(role));
        expect(back.roles).toEqual([`role:${role.name}`]);
        const restored = await roleRow(role.name);
        expect(restored.archivedAt).toBeNull();
        expect(restored.unprovisionedAt).toBeNull();
        expect(restored.isActive).toBe(true);
      });
    });
  });

  describe("webhooks", () => {
    const ORG_CREATED = "auth.organization.created";

    const ORG_UPDATED = "auth.organization.updated";

    const webhook = (
      extra: Partial<ResolvedWebhook> = {}
    ): ResolvedWebhook => ({
      key: "org-events",
      url: "https://example.com/owned",
      events: [ORG_CREATED],
      organizations: "all",
      description: null,
      secretEnv: "ORG_EVENTS_WEBHOOK_SECRET",
      secretPlain: randomBytes(32).toString("hex"),
      ...extra,
    });

    /** A service that reads organization events, subscribed through `webhooks`. */
    const subscriber = (...webhooks: ResolvedWebhook[]) =>
      serviceDoc({
        access: { roles: ["tenant_resolver"], audiences: [] },
        webhooks,
      });

    const endpointRow = (provisioningKey: string) =>
      prisma.webhookEndpoint.findUniqueOrThrow({
        where: { provisioningKey },
        include: { subscriptions: { orderBy: { eventType: "asc" } } },
      });

    const eventsOf = (row: Awaited<ReturnType<typeof endpointRow>>) =>
      row.subscriptions.map((s) => s.eventType);

    it("creates an owned endpoint for every organization", async () => {
      const w = webhook({ description: "Organization events" });
      const d = subscriber(w);
      const result = await apply(d);
      const key = `${d.service.slug}:org-events`;
      expect(result.created).toContain(`webhook:${key}`);

      const s = await serviceRow(d.service.slug);
      const row = await endpointRow(key);
      expect(row.organizationId).toBeNull();
      expect(row.ownerServiceId).toBe(s.id);
      expect(row.createdBy).toBe(s.client!.serviceAccountUser!.id);
      expect(row.provisioned).toBe(true);
      expect(row.status).toBe("ACTIVE");
      expect(row.url).toBe(w.url);
      expect(row.description).toBe("Organization events");
      expect(eventsOf(row)).toEqual([ORG_CREATED]);
      expect((await openEndpointSecrets(row)).signingSecret).toBe(
        w.secretPlain
      );

      const audit = await prisma.auditLogEntry.findFirstOrThrow({
        where: { entityId: row.id, action: "CREATE" },
      });
      expect(audit.userId).toBe(SYSTEM_USER_ID);
      expect(audit.metadata).toMatchObject({
        file: d.file,
        version: d.version,
      });
    });

    it("creates one endpoint per listed organization", async () => {
      const orgs = [
        await ensureTestOrganization("owned-webhooks-1"),
        await ensureTestOrganization("owned-webhooks-2"),
      ].sort();
      const d = subscriber(webhook({ organizations: orgs }));
      await apply(d);

      const s = await serviceRow(d.service.slug);
      const rows = await prisma.webhookEndpoint.findMany({
        where: { ownerServiceId: s.id },
        orderBy: { organizationId: "asc" },
      });
      expect(rows.map((r) => r.organizationId)).toEqual(orgs);
      expect(rows.map((r) => r.provisioningKey)).toEqual(
        orgs.map((org) => `${d.service.slug}:org-events:${org}`)
      );
    });

    it("updates url, events and description in place on reapply", async () => {
      const w = webhook();
      const d = subscriber(w);
      await apply(d);
      const key = `${d.service.slug}:org-events`;
      const before = await endpointRow(key);

      const changed = withService(d, {
        webhooks: [
          {
            ...w,
            url: "https://example.com/moved",
            events: [ORG_UPDATED, ORG_CREATED],
            description: "Moved",
          },
        ],
      });
      const result = await apply(changed);
      expect(result.updated).toEqual([`webhook:${key}`]);

      const after = await endpointRow(key);
      expect(after.id).toBe(before.id);
      expect(after.url).toBe("https://example.com/moved");
      expect(after.description).toBe("Moved");
      expect(eventsOf(after)).toEqual([ORG_CREATED, ORG_UPDATED]);
      expect(after.previousSigningSecret).toBeNull();

      const again = await apply(changed);
      expect(again.updated).toEqual([]);
      expect(again.created).toEqual([]);
    });

    it("rotates the secret when the env value changes", async () => {
      const w = webhook();
      const d = subscriber(w);
      await apply(d);
      const key = `${d.service.slug}:org-events`;

      const next = randomBytes(32).toString("hex");
      const result = await apply(
        withService(d, { webhooks: [{ ...w, secretPlain: next }] })
      );
      expect(result.rotated).toEqual([`webhook:${key}`]);

      const row = await endpointRow(key);
      expect(row.previousSecretExpiresAt).not.toBeNull();
      const secrets = await openEndpointSecrets(row);
      expect(secrets.signingSecret).toBe(next);
      expect(secrets.previousSigningSecret).toBe(w.secretPlain);
    });

    it("archives a webhook dropped from the file at once, and restores it when it returns", async () => {
      const d = subscriber(webhook());
      await apply(d);
      const key = `${d.service.slug}:org-events`;

      const dropped = await apply(withService(d, { webhooks: [] }));
      expect(dropped.unprovisioned).toEqual([`webhook:${key}`]);
      const archived = await endpointRow(key);
      expect(archived.archivedAt).not.toBeNull();
      const audit = await prisma.auditLogEntry.findFirstOrThrow({
        where: { entityId: archived.id, action: "ARCHIVE" },
      });
      expect(audit.userId).toBe(SYSTEM_USER_ID);
      expect(audit.metadata).toMatchObject({
        file: d.file,
        version: d.version,
      });

      const back = await apply(d);
      expect(back.updated).toEqual([`webhook:${key}`]);
      expect((await endpointRow(key)).archivedAt).toBeNull();
    });

    it("leaves a disabled endpoint disabled on reapply", async () => {
      const d = subscriber(webhook());
      await apply(d);
      const key = `${d.service.slug}:org-events`;
      await prisma.webhookEndpoint.update({
        where: { provisioningKey: key },
        data: { status: "DISABLED" },
      });

      await apply(d);
      expect((await endpointRow(key)).status).toBe("DISABLED");
    });
  });

  describe("provisioned integrations", () => {
    const createdSlugs: string[] = [];

    const createdRoleNames: string[] = [];

    let adminToken: string;

    let orgId: string;

    const rand = () => randomBytes(5).toString("hex");

    const newSecret = () => {
      const { plainSecret, hashedSecret } = generateClientSecret();
      return { plain: plainSecret, hash: hashedSecret };
    };

    const api = (method: string, path: string, body?: unknown) =>
      fetchJson(method, `${CORE_URL}${path}`, adminToken, body);

    const integrationSpec = (
      extra: Partial<ResolvedIntegration> = {}
    ): ResolvedIntegration & { plainSecret: string } => {
      const slug = extra.slug ?? `int-prov-${rand()}`;
      createdSlugs.push(slug);
      const secret = newSecret();
      return {
        slug,
        name: `Integration ${slug}`,
        organizationId: null,
        clientId: slug,
        secretEnv: "INTEGRATION_SECRET",
        secretHash: secret.hash,
        roles: [],
        audiences: [],
        ...extra,
        plainSecret: secret.plain,
      };
    };

    const serviceSpec = (): ResolvedService => {
      const slug = `prov-${rand()}`;
      createdSlugs.push(slug);
      return {
        slug,
        name: `Service ${slug}`,
        namespace: slug,
        clientId: slug,
        internalHost: null,
        secretEnv: "SERVICE_SECRET",
        secretHash: newSecret().hash,
        access: { roles: [], audiences: [] },
        permissions: [],
        systemRoles: [],
        buckets: [],
        eventTypes: [],
        webhooks: [],
      };
    };

    const roleEntry = (
      permissions: string[],
      orgAssignable = true
    ): CustomRoleEntry => {
      const name = `prov-role-${rand()}`;
      createdRoleNames.push(name);
      return {
        name,
        displayName: name,
        orgAssignable,
        requires2fa: false,
        permissions,
      };
    };

    const doc = (
      parts: Partial<Pick<LoadedDocument, "service" | "roles" | "integrations">>
    ): LoadedDocument => ({
      file: `doc-${rand()}.json`,
      version: "1.0.0",
      service: null,
      clients: [],
      roles: [],
      integrations: [],
      ...parts,
    });

    const issueToken = async (clientId: string, secret: string) => {
      const response = await fetch(`${CORE_URL}/oauth/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { access_token: string }).access_token;
    };

    const tokenClaims = async (clientId: string, secret: string) => {
      const token = await issueToken(clientId, secret);
      return JSON.parse(
        Buffer.from(token.split(".")[1], "base64url").toString()
      ) as { org_id?: string; aud?: string | string[] };
    };

    /** The live permissions of a fresh token, as introspection reports them. */
    const tokenPermissions = async (clientId: string, secret: string) => {
      const res = await fetch(`${CORE_URL}/oauth/introspect`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          token: await issueToken(clientId, secret),
        }).toString(),
      });
      expect(res.status).toBe(200);
      return (
        ((await res.json()) as { permissions?: string[] }).permissions ?? []
      );
    };

    beforeAll(async () => {
      // Events are written in this process, outside the server.
      await ensureDefaultOrganization();
      adminToken = await getTestPrincipalToken({
        permissions: ["integrations.read", "integrations.write", "admin"],
      });
      orgId = await ensureTestOrganization("integrations-prov-org");
    });

    afterAll(async () => {
      await removeServices(createdSlugs);
      await removeRoles(createdRoleNames);
    });

    it("creates an org-bound integration with its roles and audiences, read-only in the admin API", async () => {
      const service = serviceSpec();
      const role = roleEntry(["webhooks.read"]);
      const spec = integrationSpec({
        organizationId: orgId,
        roles: [role.name],
        audiences: [service.slug],
      });
      const { plainSecret, ...integration } = spec;
      const result = await applyProvisioning({
        documents: [
          doc({ service }),
          doc({ roles: [role], integrations: [integration] }),
        ],
      });
      expect(result.created).toContain(`integration:${spec.slug}`);

      const row = await prisma.service.findUniqueOrThrow({
        where: { slug: spec.slug },
      });
      expect(row).toMatchObject({
        kind: "integration",
        provisioned: true,
        organizationId: orgId,
        namespace: null,
      });

      const claims = await tokenClaims(spec.clientId, plainSecret);
      expect(claims.org_id).toBe(orgId);
      expect(await tokenPermissions(spec.clientId, plainSecret)).toContain(
        "webhooks.read"
      );
      expect([claims.aud].flat()).toContain(service.slug);

      const got = await api("GET", `/v1/admin/integrations/${row.id}`);
      expect(got.status).toBe(200);
      expect(got.body.provisioned).toBe(true);

      for (const [method, path, body] of [
        ["PATCH", "", { name: "x" }],
        ["PUT", "/roles", { roleIds: [] }],
        ["PUT", "/audiences", { slugs: [] }],
        ["POST", "/regenerate-secret", undefined],
      ] as const) {
        const res = await api(
          method,
          `/v1/admin/integrations/${row.id}${path}`,
          body
        );
        expect(res.status).toBe(409);
        expect(res.body.error).toBe("managed_by_provisioning");
      }
      expect(
        (
          await api(
            "POST",
            `/v1/admin/integrations/${row.id}/revoke-previous-secret`
          )
        ).status
      ).toBe(200);

      // Unchanged on a second apply.
      const again = await applyProvisioning({
        documents: [
          doc({ service }),
          doc({ roles: [role], integrations: [integration] }),
        ],
      });
      expect(again.created).toEqual([]);
      expect(again.updated).toEqual([]);
      expect(again.access).toEqual([]);
    });

    it("creates a platform integration with a core role", async () => {
      const { plainSecret, ...integration } = integrationSpec({
        roles: ["user_resolver"],
      });
      await applyProvisioning({
        documents: [doc({ integrations: [integration] })],
      });
      const claims = await tokenClaims(integration.clientId, plainSecret);
      expect(claims.org_id).toBeUndefined();
      expect(
        await tokenPermissions(integration.clientId, plainSecret)
      ).toContain("users.read");
    });

    it("resolves a core role's name to core's role, never an admin-made custom role", async () => {
      const permission = await prisma.permission.findUniqueOrThrow({
        where: { name: "webhooks.read" },
      });
      await prisma.role.create({
        data: {
          name: "user_resolver",
          displayName: "Admin-made lookalike",
          rolePermissions: { create: [{ permissionId: permission.id }] },
        },
      });
      try {
        const { plainSecret, ...integration } = integrationSpec({
          roles: ["user_resolver"],
        });
        await applyProvisioning({
          documents: [doc({ integrations: [integration] })],
        });
        const permissions = await tokenPermissions(
          integration.clientId,
          plainSecret
        );
        expect(permissions).toContain("users.read");
        expect(permissions).not.toContain("webhooks.read");
      } finally {
        await removeRoles(["user_resolver"]);
      }
    });

    it("changes roles on reapply, and marks a dropped integration unprovisioned then deactivates it", async () => {
      const { plainSecret, ...integration } = integrationSpec({
        roles: ["user_resolver"],
      });
      await applyProvisioning({
        documents: [doc({ integrations: [integration] })],
      });
      const changed = await applyProvisioning({
        documents: [doc({ integrations: [{ ...integration, roles: [] }] })],
      });
      expect(changed.access).toContain(`integration:${integration.slug} roles`);
      expect(
        await tokenPermissions(integration.clientId, plainSecret)
      ).not.toContain("users.read");

      const now = new Date();
      const dropped = await applyProvisioning(
        { documents: [doc({ roles: [roleEntry(["webhooks.read"])] })] },
        now
      );
      expect(dropped.unprovisioned).toContain(
        `integration:${integration.slug}`
      );
      const later = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 365);
      await deprovisionMissing(later);
      const row = await prisma.service.findUniqueOrThrow({
        where: { slug: integration.slug },
      });
      expect(row.isActive).toBe(false);
    });
  });
});
