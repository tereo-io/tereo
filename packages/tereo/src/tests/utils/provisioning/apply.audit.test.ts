// @module-tag int
// @module-tag provisioning
import { ensureDefaultOrganization } from "../../../utils/defaultOrganization.js";
import { type CustomRoleEntry } from "../../../utils/provisioning/schema.js";
import { applyProvisioning } from "../../../utils/provisioning/index.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateClientSecret } from "../../../utils/crypto.js";
import { TEST_SERVICE_ID } from "../../support/testService.js";
import { prisma } from "../../../utils/db/prisma.js";
import db from "../../../utils/db/index.js";
import { randomBytes } from "crypto";
import {
  type LoadedDocument,
  type ProvisioningSet,
  type ResolvedClient,
  type ResolvedService,
  type ResolvedWebhook,
  type ResolvedIntegration,
} from "../../../utils/provisioning/load.js";
import {
  DEFAULT_ORGANIZATION_ID,
  SYSTEM_USER_ID,
} from "../../../definitions/index.js";
import {
  removeLoginClients,
  removeRoles,
  removeServices,
} from "../../support/provisioning.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../support/webhooks.js";

const createdSlugs: string[] = [];

const createdClientIds: string[] = [];

const createdRoleNames: string[] = [];

const rand = () => `p${randomBytes(5).toString("hex")}`;

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

const clientSpec = (extra: Partial<ResolvedClient> = {}): ResolvedClient => {
  const spec: ResolvedClient = {
    clientId: `prov-client-${rand()}`,
    name: "Provisioned app",
    description: null,
    clientType: "public",
    secretEnv: null,
    secretHash: null,
    redirectUris: ["https://app.example.com/callback"],
    postLogoutRedirectUris: [],
    scopes: ["openid", "profile"],
    grantTypes: ["authorization_code", "refresh_token"],
    audience: [],
    consentRequired: true,
    trustedCoreScopes: [],
    ...extra,
  };
  createdClientIds.push(spec.clientId);
  return spec;
};

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

const serviceRow = (slug: string) =>
  prisma.service.findUniqueOrThrow({
    where: { slug },
    include: { client: { include: { serviceAccountUser: true } } },
  });

const clientRow = (clientId: string) =>
  prisma.oAuthClient.findUniqueOrThrow({ where: { clientId } });

beforeAll(async () => {
  // Events are written in this process, outside the server.
  await ensureDefaultOrganization();
});

afterAll(async () => {
  await removeRoles(createdRoleNames);
  await removeServices(createdSlugs);
  await removeLoginClients(createdClientIds);
});

describe("applyProvisioning", () => {
  it("records audit entries as the system user, with the document's file and version", async () => {
    const d = serviceDoc({}, { version: "2.3.4" });
    const client = clientSpec();
    await apply(d, clientsDoc(client));
    const ids = [
      (await serviceRow(d.service.slug)).id,
      (await clientRow(client.clientId)).id,
    ];
    const all = await prisma.auditLogEntry.findMany({
      where: { entityId: { in: ids } },
    });
    for (const entry of all) {
      expect(entry.userId).toBe(SYSTEM_USER_ID);
      expect(entry.writerUserId).toBe(SYSTEM_USER_ID);
    }
    for (const entry of all.filter((e) => e.entityType === "Service"))
      expect(entry.metadata).toMatchObject({ file: d.file, version: "2.3.4" });
    // The service's (empty) declaration is applied too.
    expect(all.filter((e) => e.action === "UPDATE")).toHaveLength(1);
    const entries = all.filter((e) => e.action === "CREATE");
    expect(entries.map((e) => e.entityType).sort()).toEqual([
      "OAuthClient",
      "Service",
    ]);
    const service = entries.find((e) => e.entityType === "Service")!;
    expect(service.metadata).toMatchObject({ file: d.file, version: "2.3.4" });
    const login = entries.find((e) => e.entityType === "OAuthClient")!;
    expect(login.metadata).toMatchObject({
      file: "clients.json",
      version: "1.0.0",
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

    it("emits auth.role.updated with unprovisionedAt when a role drops out of the set and returns", async () => {
      const endpoint = await createTestWebhookEndpoint(
        await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
        { eventTypes: ["auth.role.updated"] }
      );
      const role = roleSpec(["roles.read"]);
      await apply(rolesDoc(role));
      const { id } = await roleRow(role.name);

      const now = new Date();
      await applyProvisioning(setOf(), now);
      await waitForDelivered(endpoint.id, "auth.role.updated", id, {
        id,
        name: role.name,
        provisioned: true,
        unprovisionedAt: now.toISOString(),
      });

      await apply(rolesDoc(role));
      await waitForDelivered(endpoint.id, "auth.role.updated", id, {
        id,
        unprovisionedAt: null,
      });
    });
  });

  describe("webhooks", () => {
    const ORG_CREATED = "auth.organization.created";

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

    it(
      "emits webhook.endpoint.* events for what it creates, changes, rotates, archives and restores",
      { tags: ["slow"] },
      async () => {
        const { endpoint: receiver } = await db.webhookEndpoints.create({
          organizationId: null,
          ownerServiceId: TEST_SERVICE_ID,
          createdBy: SYSTEM_USER_ID,
          url: "https://example.com/endpoint-events",
          eventTypes: [
            "webhook.endpoint.created",
            "webhook.endpoint.updated",
            "webhook.endpoint.secret-rotated",
            "webhook.endpoint.archived",
            "webhook.endpoint.restored",
          ],
        });
        try {
          const w = webhook();
          const d = subscriber(w);
          await apply(d);
          const { id } = await endpointRow(`${d.service.slug}:org-events`);
          const delivered = (eventType: string, fields = {}) =>
            waitForDelivered(receiver.id, eventType, id, fields);
          await delivered("webhook.endpoint.created", { provisioned: true });

          const moved = { ...w, url: "https://www.example.com/moved-events" };
          await apply(withService(d, { webhooks: [moved] }));
          await delivered("webhook.endpoint.updated", {
            url: "https://www.example.com",
          });

          const rotated = {
            ...moved,
            secretPlain: randomBytes(32).toString("hex"),
          };
          await apply(withService(d, { webhooks: [rotated] }));
          await delivered("webhook.endpoint.secret-rotated");

          await apply(withService(d, { webhooks: [] }));
          await delivered("webhook.endpoint.archived");

          await apply(withService(d, { webhooks: [rotated] }));
          await delivered("webhook.endpoint.restored", { archivedAt: null });
        } finally {
          await prisma.webhookDelivery.deleteMany({
            where: { webhookEndpointId: receiver.id },
          });
          await prisma.webhookEndpoint.delete({ where: { id: receiver.id } });
        }
      }
    );
  });

  describe("provisioned integrations", () => {
    const createdSlugs: string[] = [];

    const rand = () => randomBytes(5).toString("hex");

    const newSecret = () => {
      const { plainSecret, hashedSecret } = generateClientSecret();
      return { plain: plainSecret, hash: hashedSecret };
    };

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

    beforeAll(async () => {
      // Events are written in this process, outside the server.
      await ensureDefaultOrganization();
    });

    afterAll(async () => {
      await removeServices(createdSlugs);
    });

    it("emits core.integration.updated with unprovisionedAt when an integration drops out of the set and returns", async () => {
      const endpoint = await createTestWebhookEndpoint(
        await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
        { eventTypes: ["core.integration.updated"] }
      );
      const { plainSecret: _p, ...integration } = integrationSpec();
      const set = { documents: [doc({ integrations: [integration] })] };
      await applyProvisioning(set);
      const { id } = await prisma.service.findUniqueOrThrow({
        where: { slug: integration.slug },
      });

      const delivered = (unprovisionedAt: string | null) =>
        waitFor(async () => {
          const deliveries = await prisma.webhookDelivery.findMany({
            where: {
              webhookEndpointId: endpoint.id,
              eventType: "core.integration.updated",
              payload: { path: ["entityId"], equals: id },
            },
          });
          return deliveries.some((d) => {
            const { data } = d.payload as { data: Record<string, unknown> };
            return (
              data.id === id &&
              data.slug === integration.slug &&
              data.unprovisionedAt === unprovisionedAt
            );
          });
        }, 10_000);

      const now = new Date();
      await applyProvisioning({ documents: [doc({})] }, now);
      await delivered(now.toISOString());

      await applyProvisioning(set);
      await delivered(null);
    });
  });
});
