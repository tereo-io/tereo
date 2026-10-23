import { ensureDefaultOrganization } from "../../utils/defaultOrganization.js";
import { applyProvisioning } from "../../utils/provisioning/index.js";
import { generateClientSecret } from "../../utils/crypto.js";
import type { Credentials } from "./clientToken.js";
import { prisma } from "../../utils/db/prisma.js";
import { removeBuckets } from "./files.js";
import { CORE_URL } from "./coreUrl.js";
import { fetchJson } from "./http.js";
import { randomBytes } from "crypto";
import { expect } from "vitest";
import type { z } from "zod";
import type {
  ResolvedClient,
  ResolvedService,
} from "../../utils/provisioning/load.js";
import {
  bucketItem,
  eventTypeItem,
  permissionItem,
  systemRoleItem,
} from "../../utils/registry.js";

// Production never deletes a service or an integration; tests do, with
// everything that would otherwise hold it: its buckets with their objects, its
// webhook endpoints and event types, its declared roles and permissions, its
// access rows, and its service-account user with that user's roles,
// memberships and audit entries.
export async function removeServices(slugs: string[]) {
  const services = await prisma.service.findMany({
    where: { slug: { in: slugs } },
    include: { client: { include: { serviceAccountUser: true } } },
  });
  const ids = services.map((s) => s.id);
  const clientIds = services.flatMap((s) => (s.client ? [s.client.id] : []));
  const userIds = services.flatMap((s) =>
    s.client?.serviceAccountUser ? [s.client.serviceAccountUser.id] : []
  );
  const buckets = await prisma.bucket.findMany({
    where: { serviceId: { in: ids } },
    select: { id: true },
  });
  await removeBuckets(buckets.map((b) => b.id));
  const endpoints = {
    OR: [{ ownerServiceId: { in: ids } }, { createdBy: { in: userIds } }],
  };
  const eventTypes = (
    await prisma.eventType.findMany({
      where: { serviceId: { in: ids } },
      select: { eventType: true },
    })
  ).map((e) => e.eventType);
  await prisma.webhookDelivery.deleteMany({
    where: {
      OR: [{ webhookEndpoint: endpoints }, { eventType: { in: eventTypes } }],
    },
  });
  await prisma.webhookEndpoint.deleteMany({ where: endpoints });
  await prisma.webhookEndpointEventType.deleteMany({
    where: { eventType: { in: eventTypes } },
  });
  await prisma.eventType.deleteMany({ where: { serviceId: { in: ids } } });
  await prisma.serviceAccess.deleteMany({ where: { serviceId: { in: ids } } });
  await prisma.role.deleteMany({ where: { serviceId: { in: ids } } });
  await prisma.permission.deleteMany({ where: { serviceId: { in: ids } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  // An org-bound integration's account is a member of its organization.
  await prisma.organizationMember.deleteMany({
    where: { userId: { in: userIds } },
  });
  await prisma.auditLogEntry.deleteMany({
    where: {
      OR: [{ userId: { in: userIds } }, { writerUserId: { in: userIds } }],
    },
  });
  await prisma.service.deleteMany({ where: { id: { in: ids } } });
  // Its tokens and login-flow rows go with it (ON DELETE CASCADE).
  await prisma.oAuthClient.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

export async function removeRoles(names: string[]) {
  const roles = await prisma.role.findMany({
    where: { name: { in: names }, serviceId: null },
    select: { id: true },
  });
  const ids = roles.map((r) => r.id);
  await prisma.userRole.deleteMany({ where: { roleId: { in: ids } } });
  await prisma.rolePermission.deleteMany({ where: { roleId: { in: ids } } });
  await prisma.role.deleteMany({ where: { id: { in: ids } } });
}

export async function removeLoginClients(clientIds: string[]) {
  await prisma.oAuthClient.deleteMany({
    where: { clientId: { in: clientIds }, service: { is: null } },
  });
}

// Rows a run left behind, by the prefixes the provisioning and registry tests
// use.
export async function cleanupAllTestEntities() {
  const services = await prisma.service.findMany({
    where: {
      OR: [
        { slug: { startsWith: "prov-" } },
        { slug: { startsWith: "hand-" } },
        { slug: { startsWith: "reg-" } },
        { slug: { startsWith: "int-" } },
      ],
    },
    select: { slug: true },
  });
  const roles = await prisma.role.findMany({
    where: { name: { startsWith: "prov-role-" }, serviceId: null },
    select: { name: true },
  });
  await removeRoles(roles.map((r) => r.name));
  await removeServices(services.map((s) => s.slug));
  const clients = await prisma.oAuthClient.findMany({
    where: { clientId: { startsWith: "prov-client-" }, service: { is: null } },
    select: { clientId: true },
  });
  await removeLoginClients(clients.map((c) => c.clientId));
}

export interface ProvisionSpec {
  /** Given to re-provision a service an earlier call made. */
  slug?: string;
  namespace?: string;
  declaration?: {
    permissions?: z.input<typeof permissionItem>[];
    systemRoles?: z.input<typeof systemRoleItem>[];
    buckets?: z.input<typeof bucketItem>[];
    eventTypes?: z.input<typeof eventTypeItem>[];
  };
  access?: { roles?: string[]; audiences?: string[] };
  version?: string;
}

export interface ProvisionedService {
  id: string;
  slug: string;
  namespace: string;
  credentials: { clientId: string; clientSecret: string };
}

// Each service's secret, so provisioning it again keeps its credentials.
const provisionedSecrets = new Map<
  string,
  { namespace: string; plain: string; hash: string }
>();

/**
 * Provision these services in one set, as a deploy's documents would. A slug
 * an earlier call provisioned keeps its namespace and secret.
 */
export async function provisionServices(
  specs: ProvisionSpec[]
): Promise<ProvisionedService[]> {
  const services = specs.map((spec) => {
    const slug = spec.slug ?? `reg-${randomBytes(5).toString("hex")}`;
    let secret = provisionedSecrets.get(slug);
    if (!secret) {
      const { plainSecret, hashedSecret } = generateClientSecret();
      secret = {
        namespace: spec.namespace ?? slug,
        plain: plainSecret,
        hash: hashedSecret,
      };
      provisionedSecrets.set(slug, secret);
    }
    const d = spec.declaration ?? {};
    const service: ResolvedService = {
      slug,
      name: `Service ${slug}`,
      namespace: secret.namespace,
      clientId: slug,
      internalHost: null,
      secretEnv: "SERVICE_SECRET",
      secretHash: secret.hash,
      access: {
        roles: spec.access?.roles ?? [],
        audiences: spec.access?.audiences ?? [],
      },
      permissions: (d.permissions ?? []).map((p) => permissionItem.parse(p)),
      systemRoles: (d.systemRoles ?? []).map((r) => systemRoleItem.parse(r)),
      buckets: (d.buckets ?? []).map((b) => bucketItem.parse(b)),
      eventTypes: (d.eventTypes ?? []).map((e) => eventTypeItem.parse(e)),
      webhooks: [],
    };
    return { service, version: spec.version ?? "1.0.0", secret };
  });
  // Events are written in this process, outside the server.
  await ensureDefaultOrganization();
  await applyProvisioning({
    documents: services.map(({ service, version }) => ({
      file: `${service.slug}.json`,
      version,
      service,
      clients: [],
      roles: [],
    })),
  });
  const rows = await prisma.service.findMany({
    where: { slug: { in: services.map((s) => s.service.slug) } },
    select: { id: true, slug: true },
  });
  return services.map(({ service, secret }) => ({
    id: rows.find((r) => r.slug === service.slug)!.id,
    slug: service.slug,
    namespace: service.namespace,
    credentials: { clientId: service.clientId, clientSecret: secret.plain },
  }));
}

export async function provisionService(
  spec: ProvisionSpec = {}
): Promise<ProvisionedService> {
  return (await provisionServices([spec]))[0];
}

const rand = () => `x${randomBytes(5).toString("hex")}`;

export const newSlug = () => `reg-${rand()}`;

export interface AddedService {
  id: string;
  slug: string;
  namespace: string;
  credentials: Credentials;
}

export const addService = async (
  adminToken: string,
  overrides: { name?: string; slug?: string; namespace?: string } = {}
): Promise<AddedService> => {
  const id = rand();
  const res = await fetchJson(
    "POST",
    `${CORE_URL}/v1/admin/services`,
    adminToken,
    {
      name: `Svc ${id}`,
      slug: `svc-${id}-service`,
      ...overrides,
    }
  );
  // The body says which conflict, should this ever answer 409 again.
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
};

export type Declaration = NonNullable<ProvisionSpec["declaration"]>;

/** A small valid declaration under the namespace. */
export const declarationFor = (
  ns: string,
  extra: Partial<Declaration> = {}
): Declaration => ({
  permissions: [
    { name: `${ns}.items.read`, displayName: "Read items" },
    { name: `${ns}.items.write`, displayName: "Write items" },
  ],
  systemRoles: [
    {
      name: `${ns}_item_reader`,
      displayName: "Item reader",
      permissions: [`${ns}.items.read`],
    },
  ],
  buckets: [],
  eventTypes: [
    { eventType: `${ns}.item.created`, description: "Item created" },
  ],
  ...extra,
});

/** A service provisioned with `declarationFor` its namespace, its slug. */
export const provisionDeclared = (
  extra: Partial<Declaration> = {},
  spec: Omit<ProvisionSpec, "declaration"> = {}
) => {
  const slug = spec.slug ?? newSlug();
  return provisionService({
    ...spec,
    slug,
    declaration: declarationFor(spec.namespace ?? slug, extra),
  });
};

export const provisionRand = () => `p${randomBytes(5).toString("hex")}`;

/** A resolved client with a fresh id; the caller removes it afterwards. */
export const newClientSpec = (
  extra: Partial<ResolvedClient> = {}
): ResolvedClient => ({
  clientId: `prov-client-${provisionRand()}`,
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
});

/** A declaration with one role, `<ns>_item_reader`, granting `grants`. */
export const ownerDeclaration = (ns: string, grants: string[] = ["read"]) => ({
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
