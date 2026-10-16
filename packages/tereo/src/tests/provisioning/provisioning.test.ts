import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import type { CustomRoleEntry } from "../../utils/provisioning/schema.js";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openEndpointSecrets } from "../../utils/webhookSecrets.js";
import { generateClientSecret } from "../../utils/crypto.js";
import { prisma } from "../../utils/db/prisma.js";
import { logger } from "../../utils/logger.js";
import { CORE_URL } from "../utils/coreUrl.js";
import { fetchJson } from "../utils/http.js";
import db from "../../utils/db/index.js";
import { randomBytes } from "crypto";
import env from "../../env.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../webhooks/utils/test-helpers.js";
import {
  applyProvisioning,
  deprovisionMissing,
  provision,
} from "../../utils/provisioning/index.js";
import {
  ProvisioningError,
  type LoadedDocument,
  type ProvisioningSet,
  type ResolvedClient,
  type ResolvedService,
  type ResolvedWebhook,
} from "../../utils/provisioning/load.js";
import {
  DEFAULT_ORGANIZATION_ID,
  SYSTEM_USER_ID,
} from "../../definitions/index.js";
import {
  removeLoginClients,
  removeRoles,
  removeServices,
} from "./utils/test-helpers.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../utils/principals.js";

let adminToken: string;
const createdSlugs: string[] = [];
const createdClientIds: string[] = [];
const createdRoleNames: string[] = [];

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

const rand = () => `p${randomBytes(5).toString("hex")}`;

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

const problemsOf = async (...docs: LoadedDocument[]): Promise<string[]> => {
  try {
    await apply(...docs);
  } catch (err) {
    if (err instanceof ProvisioningError) return err.problems;
    throw err;
  }
  throw new Error("expected a ProvisioningError");
};

/** A declaration with one role, `<ns>_item_reader`, granting `grants`. */
const ownerDeclaration = (ns: string, grants: string[] = ["read"]) => ({
  permissions: ["read", "write"].map((verb) => ({
    name: `${ns}.items.${verb}`,
    displayName: `${verb} items`,
    description: "",
    orgAssignable: false,
  })),
  systemRoles: [
    {
      name: `${ns}_item_reader`,
      displayName: "Item reader",
      description: "",
      permissions: grants.map((verb) => `${ns}.items.${verb}`),
    },
  ],
});

const roleTarget = (owner: ServiceDoc) =>
  `${owner.service.slug}/${owner.service.namespace}_item_reader`;

const fetchToken = async (clientId: string, clientSecret: string) => {
  const response = await fetch(`${CORE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  return response.status;
};

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

const serviceToken = async (d: ServiceDoc) => {
  const response = await fetch(`${CORE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${d.service.clientId}:${d.plainSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
};

const accessRow = async (
  serviceId: string,
  kind: "role" | "audience",
  target: string
) =>
  prisma.serviceAccess.findUniqueOrThrow({
    where: { serviceId_kind_target: { serviceId, kind, target } },
  });

/** The token's row, by the jti in its payload. */
const tokenRow = (token: string) => {
  const { jti } = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString()
  ) as { jti: string };
  return prisma.accessToken.findUniqueOrThrow({ where: { jti } });
};

const holdsRole = async (slug: string, roleName: string) => {
  const userId = (await serviceRow(slug)).client!.serviceAccountUser!.id;
  return (
    (await prisma.userRole.count({
      where: { userId, role: { name: roleName }, organizationId: null },
    })) > 0
  );
};

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

  it("refuses a login client audience naming no service", async () => {
    const spec = clientSpec({ audience: ["no-such-service"] });
    const problems = await problemsOf(clientsDoc(spec));
    expect(problems.join("\n")).toContain("no-such-service");
    expect(
      await prisma.oAuthClient.findUnique({
        where: { clientId: spec.clientId },
      })
    ).toBeNull();
  });

  it("refuses the whole set when one document is invalid", async () => {
    const good = serviceDoc();
    const bad = serviceDoc({
      access: { roles: ["no-such-core-role"], audiences: [] },
    });
    const problems = await problemsOf(good, bad);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${bad.file}: services[${bad.service.slug}]`);
    expect(
      await prisma.service.findUnique({ where: { slug: good.service.slug } })
    ).toBeNull();
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

  it("refuses a secret already used by another client, current or previous", async () => {
    const holder = serviceDoc();
    await apply(holder);
    const rotated = newSecret();
    const holderRotated = withService(holder, { secretHash: rotated.hash });
    await apply(holderRotated);

    const takesCurrent = serviceDoc({ secretHash: rotated.hash });
    const takesPrevious = clientSpec({
      clientType: "confidential",
      secretEnv: "APP_SECRET",
      secretHash: holder.service.secretHash,
    });
    const problems = await problemsOf(
      holderRotated,
      takesCurrent,
      clientsDoc(takesPrevious)
    );
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toContain(
      `services[${takesCurrent.service.slug}]`
    );
    expect(problems.join("\n")).toContain(`clients[${takesPrevious.clientId}]`);
    expect(problems.join("\n")).not.toContain(rotated.hash);
    expect(problems.join("\n")).not.toContain(holder.service.secretHash);
    expect(
      await prisma.service.findUnique({
        where: { slug: takesCurrent.service.slug },
      })
    ).toBeNull();
    expect(
      await prisma.oAuthClient.findUnique({
        where: { clientId: takesPrevious.clientId },
      })
    ).toBeNull();
  });

  it("explains how to recover from reusing the previous secret", async () => {
    const d = serviceDoc();
    await apply(d);
    const next = newSecret();
    await apply(withService(d, { secretHash: next.hash }));

    // A rollback that restores the old value.
    const problems = await problemsOf(d);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${d.file}: services[${d.service.slug}]`);
    expect(problems[0]).toContain("previous secret");
    expect(problems[0]).toContain("generate-secret");
    expect((await serviceRow(d.service.slug)).client?.clientSecret).toBe(
      next.hash
    );
  });

  it("refuses an entry that matches an unprovisioned row", async () => {
    const created = await api("POST", "/v1/admin/services", {
      name: "Hand made",
      slug: `hand-${rand()}`,
    });
    expect(created.status).toBe(201);
    createdSlugs.push(created.body.slug);
    const handClient = await api("POST", "/v1/admin/clients", {
      name: "Hand made app",
      clientType: "public",
      redirectUris: ["https://hand.example.com/callback"],
      grantTypes: ["authorization_code"],
    });
    expect(handClient.status, JSON.stringify(handClient.body)).toBe(201);
    createdClientIds.push(handClient.body.clientId);

    const fresh = serviceDoc();
    const problems = await problemsOf(
      serviceDoc({
        slug: created.body.slug,
        namespace: created.body.namespace,
      }),
      fresh,
      clientsDoc(clientSpec({ clientId: handClient.body.clientId }))
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain(created.body.slug);
    expect(problems[0]).toContain("not created from the provisioning file");
    expect(problems[1]).toContain(handClient.body.clientId);
    expect(problems[1]).toContain("not created from the provisioning file");
    // No partial writes: the valid entry was not created either.
    expect(
      await prisma.service.findUnique({ where: { slug: fresh.service.slug } })
    ).toBeNull();
    expect((await serviceRow(created.body.slug)).provisioned).toBe(false);
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
      const where = {
        webhookEndpointId: endpoint.id,
        eventType,
        payload: { path: ["entityId"], equals: entityId },
      };
      await waitFor(
        async () => (await prisma.webhookDelivery.count({ where })) > 0,
        10_000
      );
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

  it("applies once when two applies race", async () => {
    const owner = serviceDoc();
    Object.assign(owner.service, ownerDeclaration(owner.service.namespace));
    const consumer = serviceDoc({
      access: { roles: [roleTarget(owner)], audiences: [owner.service.slug] },
    });
    const client = clientSpec();
    const set = setOf(owner, consumer, clientsDoc(client));
    const [a, b] = await Promise.all([
      applyProvisioning(set),
      applyProvisioning(set),
    ]);
    expect([...a.created, ...b.created].sort()).toEqual(
      [
        `client:${client.clientId}`,
        `service:${owner.service.slug}`,
        `service:${consumer.service.slug}`,
      ].sort()
    );
    expect([...a.declared, ...b.declared].sort()).toEqual(
      [
        `service:${owner.service.slug}`,
        `service:${consumer.service.slug}`,
      ].sort()
    );
    const row = await serviceRow(owner.service.slug);
    const entries = await prisma.auditLogEntry.count({
      where: { entityId: row.id, action: "CREATE" },
    });
    expect(entries).toBe(1);
    const c = await serviceRow(consumer.service.slug);
    const approvals = await prisma.auditLogEntry.count({
      where: {
        entityId: c.id,
        metadata: { path: ["action"], equals: "access_approved" },
      },
    });
    expect(approvals).toBe(1);
  });

  it("refuses admin edits to a provisioned client or service with 409 managed_by_provisioning", async () => {
    const d = serviceDoc();
    const secret = newSecret();
    const client = clientSpec({
      clientType: "confidential",
      secretEnv: "APP_SECRET",
      secretHash: secret.hash,
    });
    await apply(d, clientsDoc(client));
    const s = await serviceRow(d.service.slug);
    const c = await clientRow(client.clientId);

    const attempts = [
      await api("PATCH", `/v1/admin/clients/${c.id}`, { name: "Edited" }),
      await api("POST", `/v1/admin/clients/${c.id}/regenerate-secret`),
      await api("DELETE", `/v1/admin/clients/${c.id}`),
      await api("PATCH", `/v1/admin/services/${s.id}`, { name: "Edited" }),
      await api("POST", `/v1/admin/services/${s.id}/regenerate-secret`),
    ];
    for (const res of attempts) {
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toBe("managed_by_provisioning");
    }
    expect((await clientRow(client.clientId)).name).toBe(client.name);
    expect((await serviceRow(d.service.slug)).name).toBe(d.service.name);

    const shown = await api("GET", `/v1/admin/clients/${c.id}`);
    expect(shown.body.provisioned).toBe(true);
    const shownService = await api("GET", `/v1/admin/services/${s.id}`);
    expect(shownService.body.provisioned).toBe(true);
  });

  it("lets an admin end a provisioned service's secret overlap at once", async () => {
    const d = serviceDoc();
    await apply(d);
    const next = newSecret();
    await apply(withService(d, { secretHash: next.hash }));
    expect(await fetchToken(d.service.clientId, d.plainSecret)).toBe(200);
    const s = await serviceRow(d.service.slug);

    const res = await api(
      "POST",
      `/v1/admin/services/${s.id}/revoke-previous-secret`
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.provisioned).toBe(true);
    expect((await serviceRow(d.service.slug)).client?.previousSecretHash).toBe(
      null
    );
    expect(await fetchToken(d.service.clientId, d.plainSecret)).toBe(401);
    expect(await fetchToken(d.service.clientId, next.plain)).toBe(200);
  });

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
    expect((await serviceRow(d.service.slug)).declarationVersion).toBe("1.0.0");
  });

  it("refuses a declaration naming a permission another service owns", async () => {
    const first = serviceDoc();
    await apply(first);
    const second = serviceDoc();
    const name = `${second.service.namespace}.items.read`;
    // Set validation cannot see a row outside the set.
    await prisma.permission.create({
      data: {
        name,
        displayName: "Read",
        serviceId: (await serviceRow(first.service.slug)).id,
      },
    });
    second.service.permissions = [
      { name, displayName: "Read", description: "", orgAssignable: false },
    ];

    const problems = await problemsOf(first, second);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      `${second.file}: services[${second.service.slug}]`
    );
    expect(problems[0]).toContain(name);
    expect(
      await prisma.service.findUnique({ where: { slug: second.service.slug } })
    ).toBeNull();
  });
});

describe("access", () => {
  it("grants a core role and an audience", async () => {
    const target = serviceDoc();
    const d = serviceDoc({
      access: { roles: ["file_user"], audiences: [target.service.slug] },
    });
    const result = await apply(target, d);
    expect(result.access.length).toBe(2);

    const s = await serviceRow(d.service.slug);
    expect(await holdsRole(d.service.slug, "file_user")).toBe(true);
    expect(s.client?.audience).toEqual([target.service.slug]);
    for (const [kind, name] of [
      ["role", "file_user"],
      ["audience", target.service.slug],
    ] as const) {
      const row = await accessRow(s.id, kind, name);
      expect(row.status).toBe("approved");
      expect(row.decidedBy).toBe(SYSTEM_USER_ID);
    }
  });

  it("grants a mutual pair each other's roles in one apply", async () => {
    const a = serviceDoc();
    const b = serviceDoc();
    Object.assign(a.service, ownerDeclaration(a.service.namespace), {
      access: { roles: [roleTarget(b)], audiences: [] },
    });
    Object.assign(b.service, ownerDeclaration(b.service.namespace), {
      access: { roles: [roleTarget(a)], audiences: [] },
    });
    await apply(a, b);

    for (const [consumer, owner] of [
      [a, b],
      [b, a],
    ]) {
      expect(
        await holdsRole(
          consumer.service.slug,
          `${owner.service.namespace}_item_reader`
        )
      ).toBe(true);
      const s = await serviceRow(consumer.service.slug);
      const row = await accessRow(s.id, "role", roleTarget(owner));
      expect(row.status).toBe("approved");
      expect(row.decidedBy).toBe(SYSTEM_USER_ID);
      expect(row.approvedPermissionIds).toHaveLength(1);
    }
  });

  it("extends approved access when the role grows", async () => {
    const owner = serviceDoc();
    Object.assign(owner.service, ownerDeclaration(owner.service.namespace));
    const consumer = serviceDoc({
      access: { roles: [roleTarget(owner)], audiences: [] },
    });
    await apply(owner, consumer);

    const grown = withService(
      owner,
      ownerDeclaration(owner.service.namespace, ["read", "write"]),
      { version: "1.1.0" }
    );
    const result = await apply(grown, consumer);
    expect(result.access).toEqual([
      `service:${consumer.service.slug} extended role:${roleTarget(owner)}`,
    ]);

    const c = await serviceRow(consumer.service.slug);
    const row = await accessRow(c.id, "role", roleTarget(owner));
    expect(row.status).toBe("approved");
    expect(row.approvedPermissionIds).toHaveLength(2);
    expect(
      await db.roles.getUserPermissions(c.client!.serviceAccountUser!.id)
    ).toEqual(
      expect.arrayContaining([
        `${owner.service.namespace}.items.read`,
        `${owner.service.namespace}.items.write`,
      ])
    );
    expect(
      await prisma.auditLogEntry.count({
        where: {
          entityId: c.id,
          metadata: { path: ["action"], equals: "access_requested" },
        },
      })
    ).toBe(0);
  });

  it("follows a role that shrinks, auditing it", async () => {
    const owner = serviceDoc();
    Object.assign(
      owner.service,
      ownerDeclaration(owner.service.namespace, ["read", "write"])
    );
    const consumer = serviceDoc({
      access: { roles: [roleTarget(owner)], audiences: [] },
    });
    await apply(owner, consumer);
    const token = await serviceToken(consumer);

    const shrunk = withService(
      owner,
      ownerDeclaration(owner.service.namespace, ["read"]),
      { version: "1.1.0" }
    );
    const result = await apply(shrunk, consumer);
    expect(result.access).toEqual([
      `service:${consumer.service.slug} narrowed role:${roleTarget(owner)}`,
    ]);
    // It embeds the permission the role no longer grants.
    expect((await tokenRow(token)).revokedAt).not.toBeNull();

    const c = await serviceRow(consumer.service.slug);
    expect(
      (await accessRow(c.id, "role", roleTarget(owner))).approvedPermissionIds
    ).toHaveLength(1);
    const entries = await prisma.auditLogEntry.findMany({
      where: {
        entityId: c.id,
        metadata: { path: ["action"], equals: "access_approved" },
      },
      orderBy: { createdAt: "asc" },
    });
    expect(entries).toHaveLength(2);
    expect(entries[1].userId).toBe(SYSTEM_USER_ID);
    expect(entries[1].metadata).toMatchObject({
      file: consumer.file,
      version: consumer.version,
      access: [
        {
          kind: "role",
          target: roleTarget(owner),
          permissions: [],
          removedPermissions: [`${owner.service.namespace}.items.write`],
        },
      ],
    });
  });

  it("revokes tokens when a role swaps one permission for another", async () => {
    const owner = serviceDoc();
    Object.assign(
      owner.service,
      ownerDeclaration(owner.service.namespace, ["read"])
    );
    const consumer = serviceDoc({
      access: { roles: [roleTarget(owner)], audiences: [] },
    });
    await apply(owner, consumer);
    const token = await serviceToken(consumer);

    const swapped = withService(
      owner,
      ownerDeclaration(owner.service.namespace, ["write"]),
      { version: "1.1.0" }
    );
    const result = await apply(swapped, consumer);
    expect(result.access).toEqual([
      `service:${consumer.service.slug} extended role:${roleTarget(owner)}`,
    ]);
    expect((await tokenRow(token)).revokedAt).not.toBeNull();
  });

  it("revokes access removed from the set", async () => {
    const owner = serviceDoc();
    Object.assign(owner.service, ownerDeclaration(owner.service.namespace));
    const consumer = serviceDoc({
      access: {
        roles: [roleTarget(owner)],
        audiences: [owner.service.slug],
      },
    });
    await apply(owner, consumer);
    const token = await serviceToken(consumer);
    expect((await tokenRow(token)).revokedAt).toBeNull();

    const result = await apply(
      owner,
      withService(consumer, { access: { roles: [], audiences: [] } })
    );
    expect(result.access.sort()).toEqual(
      [
        `service:${consumer.service.slug} revoked audience:${owner.service.slug}`,
        `service:${consumer.service.slug} revoked role:${roleTarget(owner)}`,
      ].sort()
    );
    const c = await serviceRow(consumer.service.slug);
    expect((await accessRow(c.id, "role", roleTarget(owner))).status).toBe(
      "revoked"
    );
    expect(
      await holdsRole(
        consumer.service.slug,
        `${owner.service.namespace}_item_reader`
      )
    ).toBe(false);
    expect(c.client?.audience).toEqual([]);
    expect((await tokenRow(token)).revokedAt).not.toBeNull();
  });

  it("grants again access the set lists again after removing it", async () => {
    const owner = serviceDoc();
    Object.assign(owner.service, ownerDeclaration(owner.service.namespace));
    const consumer = serviceDoc({
      access: { roles: [roleTarget(owner)], audiences: [] },
    });
    await apply(owner, consumer);
    await apply(
      owner,
      withService(consumer, { access: { roles: [], audiences: [] } })
    );

    const result = await apply(owner, consumer);
    expect(result.access).toEqual([
      `service:${consumer.service.slug} granted role:${roleTarget(owner)}`,
    ]);
    const c = await serviceRow(consumer.service.slug);
    const row = await accessRow(c.id, "role", roleTarget(owner));
    expect(row.status).toBe("approved");
    expect(row.decidedBy).toBe(SYSTEM_USER_ID);
    expect(row.approvedPermissionIds).toHaveLength(1);
    expect(
      await holdsRole(
        consumer.service.slug,
        `${owner.service.namespace}_item_reader`
      )
    ).toBe(true);
  });

  it("keeps an admin's revocation while the set lists it", async () => {
    const d = serviceDoc({
      access: { roles: ["file_user"], audiences: [] },
    });
    await apply(d);
    const s = await serviceRow(d.service.slug);
    const row = await accessRow(s.id, "role", "file_user");

    const revoked = await api(
      "POST",
      `/v1/admin/services/${s.id}/access/revoke`,
      { ids: [row.id] }
    );
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

    const again = await apply(d);
    expect(again.access).toEqual([]);
    expect((await accessRow(s.id, "role", "file_user")).status).toBe("revoked");
    expect(await holdsRole(d.service.slug, "file_user")).toBe(false);
  });

  it("still lets an admin approve or revoke a provisioned service's access", async () => {
    const d = serviceDoc();
    const other = serviceDoc();
    await apply(d, other);
    const s = await serviceRow(d.service.slug);
    const request = await prisma.serviceAccess.create({
      data: { serviceId: s.id, kind: "audience", target: other.service.slug },
    });

    const approved = await api(
      "POST",
      `/v1/admin/services/${s.id}/access/approve`,
      { ids: [request.id] }
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await serviceRow(d.service.slug)).client?.audience).toEqual([
      other.service.slug,
    ]);

    const revoked = await api(
      "POST",
      `/v1/admin/services/${s.id}/access/revoke`,
      { ids: [request.id] }
    );
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect((await serviceRow(d.service.slug)).client?.audience).toEqual([]);
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

  const roleApi = async (method: string, path: string, body?: unknown) =>
    fetchJson(
      method,
      `${CORE_URL}${path}`,
      await getTestPrincipalToken({ permissions: ["admin"] }),
      body
    );

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

  it("refuses a permission missing from the database as a problem", async () => {
    // Validation knows it from core's code; the database lacks it until
    // core's declaration is registered.
    const permission = await prisma.permission.findUniqueOrThrow({
      where: { name: "roles.read" },
    });
    await prisma.permission.update({
      where: { id: permission.id },
      data: { retiredAt: new Date() },
    });
    try {
      const role = roleSpec(["roles.read"]);
      expect(await problemsOf(rolesDoc(role))).toEqual([
        `roles.json: roles[${role.name}]: permission "roles.read" does not exist in the database`,
      ]);
    } finally {
      await prisma.permission.update({
        where: { id: permission.id },
        data: { retiredAt: permission.retiredAt },
      });
    }
  });

  it("refuses a custom role whose name a hand-made role holds", async () => {
    const name = `prov-role-${rand()}`;
    createdRoleNames.push(name);
    await prisma.role.create({
      data: { name, displayName: "Hand made", requires2fa: false },
    });
    const problems = await problemsOf(
      rolesDoc(roleSpec(["roles.read"], { name }))
    );
    expect(problems.join("\n")).toContain(
      "was not created from the provisioning file"
    );
    expect((await roleRow(name)).provisioned).toBe(false);
  });

  it("refuses admin edits with 409 managed_by_provisioning, but still assigns the role", async () => {
    const owner = ownerDoc();
    const role = roleSpec([
      "roles.read",
      `${owner.service.namespace}.items.read`,
    ]);
    await apply(owner, rolesDoc(role));
    const row = await roleRow(role.name);
    const permissionId = row.rolePermissions[0].permissionId;

    const attempts = [
      await roleApi("PATCH", `/v1/admin/roles/${row.id}`, { displayName: "X" }),
      await roleApi("PUT", `/v1/admin/roles/${row.id}/permissions`, {
        permissionIds: [permissionId],
      }),
      await roleApi("POST", `/v1/admin/roles/${row.id}/archive`),
      await roleApi("DELETE", `/v1/admin/roles/${row.id}`),
      await roleApi("POST", `/v1/admin/roles/${row.id}/restore`),
    ];
    for (const res of attempts) {
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toBe("managed_by_provisioning");
    }
    const shown = await roleApi("GET", `/v1/admin/roles/${row.id}`);
    expect(shown.body.provisioned).toBe(true);

    const user = await prisma.user.create({
      data: {
        email: `prov-role-${rand()}@test.local`,
        name: "Holder",
        isActive: true,
      },
    });
    try {
      const assigned = await roleApi(
        "PUT",
        `/v1/admin/users/${user.id}/roles`,
        { roleIds: [row.id] }
      );
      expect(assigned.status, JSON.stringify(assigned.body)).toBeLessThan(300);
      expect(
        await prisma.userRole.count({
          where: { userId: user.id, roleId: row.id },
        })
      ).toBe(1);

      const copy = await roleApi(
        "POST",
        `/v1/admin/roles/${row.id}/duplicate`,
        { name: `${role.name}-copy` }
      );
      createdRoleNames.push(`${role.name}-copy`);
      expect(copy.status, JSON.stringify(copy.body)).toBe(201);
      expect(copy.body.provisioned).toBe(false);
    } finally {
      await prisma.userRole.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
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

  const webhook = (extra: Partial<ResolvedWebhook> = {}): ResolvedWebhook => ({
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
    expect((await openEndpointSecrets(row)).signingSecret).toBe(w.secretPlain);

    const audit = await prisma.auditLogEntry.findFirstOrThrow({
      where: { entityId: row.id, action: "CREATE" },
    });
    expect(audit.userId).toBe(SYSTEM_USER_ID);
    expect(audit.metadata).toMatchObject({ file: d.file, version: d.version });
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

  it("refuses an organization that does not exist", async () => {
    const missing = "00000000-0000-7000-8000-00000000dead";
    const d = subscriber(webhook({ organizations: [missing] }));
    const problems = await problemsOf(d);
    expect(problems).toEqual([
      `${d.file}: services[${d.service.slug}]: webhooks[org-events]: no organization with id ${missing}`,
    ]);
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
    expect(audit.metadata).toMatchObject({ file: d.file, version: d.version });

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

describe("provision", () => {
  it("does nothing without PROVISIONING_PATH", async () => {
    await expect(provision()).resolves.toBeNull();
  });
});
