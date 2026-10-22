// @module-tag int
// @module-tag provisioning
// @module-tag race
import { ensureDefaultOrganization } from "../../../utils/defaultOrganization.js";
import { applyProvisioning } from "../../../utils/provisioning/index.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateClientSecret } from "../../../utils/crypto.js";
import { prisma } from "../../../utils/db/prisma.js";
import { randomBytes } from "crypto";
import {
  type LoadedDocument,
  type ProvisioningSet,
  type ResolvedClient,
  type ResolvedService,
} from "../../../utils/provisioning/load.js";
import {
  removeLoginClients,
  removeServices,
} from "../../support/provisioning.js";

const createdSlugs: string[] = [];

const createdClientIds: string[] = [];

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

const serviceRow = (slug: string) =>
  prisma.service.findUniqueOrThrow({
    where: { slug },
    include: { client: { include: { serviceAccountUser: true } } },
  });

beforeAll(async () => {
  // Events are written in this process, outside the server.
  await ensureDefaultOrganization();
});

afterAll(async () => {
  await removeServices(createdSlugs);
  await removeLoginClients(createdClientIds);
});

describe("applyProvisioning", () => {
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
});
