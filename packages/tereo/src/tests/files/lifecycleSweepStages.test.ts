import { processLifecycleSweepPolicy } from "../../jobs/lifecycleSweep.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import { randomUUID } from "crypto";
import type { Job } from "bullmq";
import axios from "axios";
import {
  BASE_URL,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObject,
} from "./utils/test-helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const fakeJob = <T>(data: T): Job<T> =>
  ({
    id: `fake-${randomUUID()}`,
    data,
    updateProgress: async () => undefined,
  }) as unknown as Job<T>;

const sweep = (bucketId: number) =>
  processLifecycleSweepPolicy(fakeJob({ bucketId, continuation: 0 }));

const usage = async (bucketId: number) =>
  (await prisma.bucket.findUniqueOrThrow({ where: { id: bucketId } }))
    .currentUsageBytes;

describe("lifecycle sweep stages", () => {
  let token: string;
  const auth = () => ({
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });

  const versionedBucket = async () => {
    const bucket = await createTestBucket(token);
    const res = await axios.put(
      `${BASE_URL}/buckets/${bucket.name}`,
      { versioningEnabled: true },
      auth()
    );
    expect(res.status).toBe(200);
    return bucket as { id: number; name: string };
  };

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("purges soft-deleted objects at once with purgeSoftDeletedAfterDays 0, refunding usage", async () => {
    const bucket = await versionedBucket();
    const content = `purge ${randomUUID()}`;
    const obj = await uploadTestObject(
      token,
      bucket.name,
      "gone.txt",
      createTestFile(content)
    );
    const del = await axios.delete(
      `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}`,
      auth()
    );
    expect(del.status).toBe(204);
    expect(await usage(bucket.id)).toBe(BigInt(Buffer.byteLength(content)));

    await db.lifecyclePolicies.upsert({
      bucketId: bucket.id,
      purgeSoftDeletedAfterDays: 0,
    });
    await sweep(bucket.id);

    expect(await prisma.object.findUnique({ where: { id: obj.id } })).toBe(
      null
    );
    expect(await usage(bucket.id)).toBe(0n);
  });

  it("expires a version by how long it has been non-current, not by its age", async () => {
    const bucket = await versionedBucket();
    const old = `old ${randomUUID()}`;
    const obj = await uploadTestObject(
      token,
      bucket.name,
      "doc.txt",
      createTestFile(old)
    );
    const first = await prisma.objectVersion.findFirstOrThrow({
      where: { objectId: obj.id, isCurrent: true },
    });
    // Uploaded a year ago, overwritten now.
    await prisma.objectVersion.update({
      where: { id: first.id },
      data: { createdAt: new Date(Date.now() - 365 * DAY_MS) },
    });
    await uploadTestObject(
      token,
      bucket.name,
      "doc.txt",
      createTestFile(`new ${randomUUID()}`)
    );
    const replaced = await prisma.objectVersion.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(replaced.isCurrent).toBe(false);
    expect(replaced.noncurrentSince).not.toBeNull();
    expect(Date.now() - replaced.noncurrentSince!.getTime()).toBeLessThan(
      60_000
    );

    await db.lifecyclePolicies.upsert({
      bucketId: bucket.id,
      expireVersionsAfterDays: 30,
    });
    const before = await usage(bucket.id);
    await sweep(bucket.id);
    expect(
      (
        await prisma.objectVersion.findUniqueOrThrow({
          where: { id: first.id },
        })
      ).deletedAt
    ).toBeNull();

    // 31 days after the overwrite.
    await prisma.objectVersion.update({
      where: { id: first.id },
      data: { noncurrentSince: new Date(Date.now() - 31 * DAY_MS) },
    });
    await sweep(bucket.id);
    expect(
      (
        await prisma.objectVersion.findUniqueOrThrow({
          where: { id: first.id },
        })
      ).deletedAt
    ).not.toBeNull();
    expect(await usage(bucket.id)).toBe(
      before - BigInt(Buffer.byteLength(old))
    );
  });

  it("marks the replaced version non-current on a delete marker and a restore", async () => {
    const bucket = await versionedBucket();
    const obj = await uploadTestObject(
      token,
      bucket.name,
      "r.txt",
      createTestFile(`r ${randomUUID()}`)
    );
    const first = await prisma.objectVersion.findFirstOrThrow({
      where: { objectId: obj.id, isCurrent: true },
    });
    const del = await axios.delete(
      `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}`,
      auth()
    );
    expect(del.status).toBe(204);
    expect(
      (
        await prisma.objectVersion.findUniqueOrThrow({
          where: { id: first.id },
        })
      ).noncurrentSince
    ).not.toBeNull();

    const marker = await prisma.objectVersion.findFirstOrThrow({
      where: { objectId: obj.id, isCurrent: true },
    });
    expect(marker.isDeleteMarker).toBe(true);
    expect(marker.noncurrentSince).toBeNull();
    const restore = await axios.post(
      `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}/versions/${first.id}/restore`,
      {},
      auth()
    );
    expect(restore.status).toBeLessThan(300);
    const restored = await prisma.objectVersion.findFirstOrThrow({
      where: { objectId: obj.id, isCurrent: true },
    });
    expect(restored.noncurrentSince).toBeNull();
    expect(
      (
        await prisma.objectVersion.findUniqueOrThrow({
          where: { id: marker.id },
        })
      ).noncurrentSince
    ).not.toBeNull();
  });

  it("does not list a deleted bucket's enabled policy", async () => {
    const bucket = await createTestBucket(token);
    await db.lifecyclePolicies.upsert({
      bucketId: bucket.id,
      expireObjectsAfterDays: 1,
    });
    expect(
      (await db.lifecyclePolicies.listEnabled()).map((p) => p.bucketId)
    ).toContain(bucket.id);

    await prisma.bucket.update({
      where: { id: bucket.id },
      data: { deletedAt: new Date() },
    });
    expect(
      (await db.lifecyclePolicies.listEnabled()).map((p) => p.bucketId)
    ).not.toContain(bucket.id);
  });
});
