// @module-tag int
// @module-tag provisioning
// @module-tag race
import { ensureDefaultOrganization } from "../../../utils/defaultOrganization.js";
import { applyBranding } from "../../../utils/provisioning/brandingApply.js";
import type { ProvisioningSet } from "../../../utils/provisioning/load.js";
import { BrandingFieldsSchema } from "../../../utils/branding/schema.js";
import { storeBrandingImage } from "../../../utils/branding/storage.js";
import { ProvisioningError } from "../../../utils/provisioning/load.js";
import { SYSTEM_USER_ID } from "../../../definitions/systemUser.js";
import { lockWaiters, untilQueued } from "../../support/dbLocks.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkImage } from "../../../utils/branding/images.js";
import { prisma } from "../../../utils/db/prisma.js";
import db from "../../../utils/db/index.js";
import { randomBytes } from "node:crypto";
import {
  brandingPrincipal,
  createBrandingClient,
  deleteBrandingClients,
} from "../../support/branding.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

const lockImage = (
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  id: string
) => tx.$queryRaw`
  SELECT "id" FROM "files"."objects" WHERE "id" = ${id}::uuid FOR UPDATE`;

describe("applyBranding image locks", () => {
  const clientUuids: string[] = [];

  beforeAll(async () => {
    await ensureDefaultOrganization();
    const { userId } = await brandingPrincipal([]);
    for (let i = 0; i < 2; i++)
      clientUuids.push((await createBrandingClient(userId)).id);
  });

  afterAll(async () => {
    await prisma.brandingProfile.deleteMany({
      where: { clientId: { in: clientUuids } },
    });
    await deleteBrandingClients(clientUuids);
  });

  it("takes every image lock in one id order, so a save locking them in id order cannot deadlock with it", async () => {
    const clients = await prisma.oAuthClient.findMany({
      where: { id: { in: clientUuids } },
      orderBy: { id: "asc" },
    });
    const images = await Promise.all(
      [0, 1].map(() =>
        checkImage("logo", Buffer.concat([PNG, randomBytes(16)]))
      )
    );
    const stored = await Promise.all(
      images.map((image) => storeBrandingImage(image, SYSTEM_USER_ID))
    );
    const objectIds = new Map(
      images.map((image, i) => [image.sha256, stored[i].objectId])
    );
    const [low, high] = images
      .map((image, i) => ({ image, id: stored[i].objectId }))
      .sort((a, b) => a.id.localeCompare(b.id));

    // Profiles are written in lock order (client id); the first one gets the
    // higher image, so per-profile locking would take it before the lower.
    const fields = BrandingFieldsSchema.parse({ appName: "Raced" });
    const set: ProvisioningSet = {
      documents: [
        {
          file: "app.json",
          version: "1.0.0",
          service: null,
          clients: [],
          roles: [],
          integrations: [],
          branding: {
            default: null,
            clients: {
              [clients[0].clientId]: { ...fields, logo: high.image },
              [clients[1].clientId]: { ...fields, logo: low.image },
            },
          },
        },
      ],
    };

    let releaseSave!: () => void;
    const saveDone = new Promise<void>((r) => (releaseSave = r));
    let lowLocked!: () => void;
    const lowHeld = new Promise<void>((r) => (lowLocked = r));
    // An admin save holding the lower image and then wanting the higher.
    const save = prisma.$transaction(
      async (tx) => {
        await lockImage(tx, low.id);
        lowLocked();
        await saveDone;
        await lockImage(tx, high.id);
      },
      { timeout: 30_000 }
    );
    await lowHeld;

    const baseline = await lockWaiters();
    const apply = prisma.$transaction(
      (tx) => applyBranding(tx, set, objectIds, { branding: [] }),
      { timeout: 30_000 }
    );
    await untilQueued(baseline, 1, 5_000);
    releaseSave();

    expect(
      (await Promise.allSettled([save, apply])).map((r) => r.status)
    ).toEqual(["fulfilled", "fulfilled"]);
    const profiles = await prisma.brandingProfile.findMany({
      where: { clientId: { in: clientUuids } },
    });
    expect(profiles).toHaveLength(2);
  });
});

describe("applyBranding racing a client delete", () => {
  it("refuses with a provisioning problem when a branded client is deleted while it waits for the profile lock", async () => {
    await ensureDefaultOrganization();
    const { userId } = await brandingPrincipal([]);
    const client = await createBrandingClient(userId);
    const set: ProvisioningSet = {
      documents: [
        {
          file: "app.json",
          version: "1.0.0",
          service: null,
          clients: [],
          roles: [],
          integrations: [],
          branding: {
            default: null,
            clients: {
              [client.clientId]: BrandingFieldsSchema.parse({ appName: "X" }),
            },
          },
        },
      ],
    };

    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const held = new Promise<void>((r) => (locked = r));
    // A client delete: the profile lock, then the client's row.
    const deletion = prisma.$transaction(
      async (tx) => {
        await db.brandingProfiles.lockForWrite({ clientUuid: client.id }, tx);
        locked();
        await released;
        await tx.oAuthClient.delete({ where: { id: client.id } });
      },
      { timeout: 30_000 }
    );
    await held;

    const baseline = await lockWaiters();
    const apply = prisma.$transaction(
      (tx) => applyBranding(tx, set, new Map(), { branding: [] }),
      { timeout: 30_000 }
    );
    await untilQueued(baseline, 1, 5_000);
    release();
    await deletion;

    const err = await apply.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvisioningError);
    expect((err as ProvisioningError).problems).toEqual([
      `app.json: branding.clients[${client.clientId}]: client "${client.clientId}" was deleted while provisioning ran`,
    ]);
  });
});
