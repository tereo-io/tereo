// @module-tag int
// @module-tag files
import { BRANDING_BUCKET } from "../../utils/branding/storage.js";
import { resetCoreBuckets } from "../../utils/coreBuckets.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { storeTestImage } from "../support/branding.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "node:crypto";

const PHOTOS = "auth-service-user-photos";

const bucket = (name: string) =>
  prisma.bucket.findFirstOrThrow({ where: { name, deletedAt: null } });

const tamper = async (name: string) => {
  const { id } = await bucket(name);
  await prisma.bucket.update({
    where: { id },
    data: {
      policy: "public",
      storageQuotaBytes: 1024n,
      versioningEnabled: true,
      autoThumbnails: true,
      corsConfig: { allowedOrigins: ["*"] },
      rateLimitConfig: { tokensPerSecond: 1, maxTokens: 1, requestCost: 1 },
    },
  });
  await prisma.bucketLifecyclePolicy.upsert({
    where: { bucketId: id },
    create: { bucketId: id, expireObjectsAfterDays: 1 },
    update: { expireObjectsAfterDays: 1, enabled: true },
  });
  return id;
};

const created: string[] = [];

afterAll(async () => {
  await prisma.object.deleteMany({ where: { id: { in: created } } });
  await resetCoreBuckets();
});

describe("resetCoreBuckets", () => {
  it("puts each core bucket's settings back as declared", async () => {
    for (const name of [PHOTOS, BRANDING_BUCKET]) {
      const id = await tamper(name);
      await resetCoreBuckets();
      const reset = await bucket(name);
      expect(reset).toMatchObject({
        policy: "private",
        storageQuotaBytes: null,
        versioningEnabled: false,
        autoThumbnails: false,
        corsConfig: null,
        rateLimitConfig: null,
      });
      expect(
        await prisma.bucketLifecyclePolicy.count({ where: { bucketId: id } })
      ).toBe(0);
      const audit = await prisma.auditLogEntry.findFirst({
        where: { entityType: "bucket", entityId: String(id) },
        orderBy: { createdAt: "desc" },
      });
      expect(audit?.metadata).toMatchObject({
        via: "core_bucket_reset",
        lifecyclePolicyRemoved: true,
      });
    }
  });

  it("purges object history so versioning can go off", async () => {
    const id = await tamper(PHOTOS);
    const object = await prisma.object.create({
      data: {
        bucketId: id,
        objectKey: `test-history/${randomUUID()}.png`,
        createdBy: SYSTEM_USER_ID,
      },
    });
    created.push(object.id);
    const old = await prisma.objectVersion.create({
      data: {
        objectId: object.id,
        isCurrent: false,
        isDeleteMarker: true,
        createdBy: SYSTEM_USER_ID,
      },
    });
    await resetCoreBuckets();
    expect((await bucket(PHOTOS)).versioningEnabled).toBe(false);
    const purged = await prisma.objectVersion.findUniqueOrThrow({
      where: { id: old.id },
    });
    expect(purged.deletedAt).not.toBeNull();
  });

  it("clears object expiry on user photos but not on branding images", async () => {
    const photos = await bucket(PHOTOS);
    const expiry = new Date(Date.now() + 3_600_000);
    const photo = await prisma.object.create({
      data: {
        bucketId: photos.id,
        objectKey: `test-expiry/${randomUUID()}.png`,
        createdBy: SYSTEM_USER_ID,
        deleteAfter: expiry,
      },
    });
    created.push(photo.id);
    const stored = await storeTestImage("logo");
    const image = await prisma.object.findFirstOrThrow({
      where: { bucket: { name: BRANDING_BUCKET }, objectKey: stored.objectKey },
    });
    await prisma.object.update({
      where: { id: image.id },
      data: { deleteAfter: expiry },
    });

    await resetCoreBuckets();

    expect(
      (await prisma.object.findUniqueOrThrow({ where: { id: photo.id } }))
        .deleteAfter
    ).toBeNull();
    expect(
      (await prisma.object.findUniqueOrThrow({ where: { id: image.id } }))
        .deleteAfter
    ).toEqual(expiry);
  });

  it("leaves a bucket already as declared alone", async () => {
    await resetCoreBuckets();
    const { id } = await bucket(PHOTOS);
    const resets = () =>
      prisma.auditLogEntry.count({
        where: {
          entityType: "bucket",
          entityId: String(id),
          metadata: { path: ["via"], equals: "core_bucket_reset" },
        },
      });
    const before = await resets();
    await resetCoreBuckets();
    expect(await resets()).toBe(before);
  });
});
