// @module-tag int
// @module-tag provisioning
// @module-tag race
import { ensureDefaultOrganization } from "../../../utils/defaultOrganization.js";
import { deprovisionMissing } from "../../../utils/provisioning/apply.js";
import { applyProvisioning } from "../../../utils/provisioning/index.js";
import { storeBrandingImage } from "../../../utils/branding/storage.js";
import { SYSTEM_USER_ID } from "../../../definitions/systemUser.js";
import { lockWaiters, untilQueued } from "../../support/dbLocks.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateClientSecret } from "../../../utils/crypto.js";
import { checkImage } from "../../../utils/branding/images.js";
import { prisma } from "../../../utils/db/prisma.js";
import db from "../../../utils/db/index.js";
import { randomBytes } from "node:crypto";
import env from "../../../env.js";
import {
  type LoadedDocument,
  type ProvisioningSet,
  type ResolvedClient,
  type ResolvedService,
} from "../../../utils/provisioning/load.js";
import {
  removeLoginClients,
  removeServices,
  provisionRand as rand,
  newClientSpec,
  ownerDeclaration,
} from "../../support/provisioning.js";
import {
  brandingPrincipal,
  createBrandingClient,
} from "../../support/branding.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

const createdSlugs: string[] = [];

const createdClientIds: string[] = [];

const clientSpec = (extra: Partial<ResolvedClient> = {}): ResolvedClient => {
  const spec = newClientSpec(extra);
  createdClientIds.push(spec.clientId);
  return spec;
};

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

describe("deprovisionMissing racing a branding save", () => {
  it("takes every due client's profile lock before any image lock, so a save sharing an image cannot deadlock with it", async () => {
    const { userId } = await brandingPrincipal([]);
    const unprovisionedAt = new Date();
    // Created in order, so the loop meets `first` before `second`.
    const first = await createBrandingClient(userId);
    const second = await createBrandingClient(userId);
    await prisma.oAuthClient.updateMany({
      where: { id: { in: [first.id, second.id] } },
      data: { provisioned: true, unprovisionedAt },
    });
    const image = await checkImage(
      "logo",
      Buffer.concat([PNG, randomBytes(16)])
    );
    const { objectId } = await storeBrandingImage(image, SYSTEM_USER_ID);
    for (const client of [first, second])
      await prisma.brandingProfile.create({
        data: {
          clientId: client.id,
          logoObjectId: objectId,
          updatedBy: SYSTEM_USER_ID,
        },
      });

    let releaseSave!: () => void;
    const saveDone = new Promise<void>((r) => (releaseSave = r));
    let profileLocked!: () => void;
    const profileHeld = new Promise<void>((r) => (profileLocked = r));
    // An admin save of `second`: its profile lock, then its images.
    const save = prisma.$transaction(
      async (tx) => {
        await db.brandingProfiles.lockForWrite({ clientUuid: second.id }, tx);
        profileLocked();
        await saveDone;
        await tx.$queryRaw`
          SELECT "id" FROM "files"."objects" WHERE "id" = ${objectId}::uuid FOR UPDATE`;
      },
      { timeout: 30_000 }
    );
    await profileHeld;

    const baseline = await lockWaiters();
    const later = new Date(
      unprovisionedAt.getTime() +
        (env.REGISTRY_RETIREMENT_GRACE_HOURS + 1) * 60 * 60 * 1000
    );
    const retire = deprovisionMissing(later);
    await untilQueued(baseline, 1, 5_000);
    releaseSave();

    expect(
      (await Promise.allSettled([save, retire])).map((r) => r.status)
    ).toEqual(["fulfilled", "fulfilled"]);
    expect(
      await prisma.oAuthClient.count({
        where: { id: { in: [first.id, second.id] } },
      })
    ).toBe(0);
  });
});
