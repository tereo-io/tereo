import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import type { Job } from "bullmq";
import axios from "axios";
import {
  processBucketCleanup,
  processBucketCleanupReconcile,
  startBucketCleanup,
  stopBucketCleanup,
  type BucketCleanupJobData,
} from "../../jobs/bucketCleanup.js";
import {
  getBucketCleanupQueue,
  getOrphanBlobCleanupQueue,
} from "../../jobs/queues.js";
import {
  BASE_URL,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObject,
  waitFor,
} from "../support/files.js";

const liveRefs = (bucketId: number) =>
  prisma.objectVersion.count({
    where: {
      object: { bucketId },
      deletedAt: null,
      isDeleteMarker: false,
      contentBlobHash: { not: null },
    },
  });

function fakeJob<T>(data: T, id = "fake-1"): Job<T> {
  return {
    id,
    data,
    updateProgress: async () => undefined,
  } as unknown as Job<T>;
}

describe("bucket cleanup job", () => {
  let token: string;

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  afterEach(async () => {
    await getBucketCleanupQueue().obliterate({ force: true });
  });

  it("DELETE /buckets/:name returns 204 immediately without blocking on cleanup", async () => {
    const bucket = await createTestBucket(token, { policy: "private" });
    // Seed a few objects so the cleanup would have non-trivial work.
    for (let i = 0; i < 3; i++) {
      await uploadTestObject(
        token,
        bucket.name,
        `obj-${i}.txt`,
        createTestFile(`content-${i}`, `obj-${i}.txt`, "text/plain")
      );
    }

    const started = Date.now();
    const res = await axios.delete(`${BASE_URL}/buckets/${bucket.name}`, {
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(204);
    // The HTTP path should not await the per-object release loop. Allow
    // generous slack for CI jitter but still well under what a synchronous
    // loop would take on many objects.
    expect(elapsed).toBeLessThan(3_000);

    // The bucket row itself should be soft-deleted immediately.
    const row = await prisma.bucket.findUnique({ where: { id: bucket.id } });
    expect(row?.deletedAt).not.toBeNull();

    // A bucket-cleanup job should have been enqueued. Because the worker is
    // started by `startBackgroundJobs()` in globalSetup, a freshly-enqueued
    // job for a small bucket may race to "completed" before this assertion
    // runs. Include "completed" so we don't flake on instant processing.
    const jobs = await getBucketCleanupQueue().getJobs(
      ["wait", "delayed", "active", "completed"],
      0,
      -1
    );
    const targeted = jobs.filter(
      (j) => (j.data as { bucketId: number }).bucketId === bucket.id
    );
    expect(targeted.length).toBeGreaterThanOrEqual(1);
  });

  it("worker releases all blob refs across multiple ticks", async () => {
    const bucket = await createTestBucket(token, { policy: "private" });
    for (let i = 0; i < 5; i++) {
      await uploadTestObject(
        token,
        bucket.name,
        `obj-${i}.txt`,
        createTestFile(`c-${i}`, `obj-${i}.txt`, "text/plain")
      );
    }
    await prisma.bucket.update({
      where: { id: bucket.id },
      data: {
        deletedAt: new Date(),
        deletedBy: "00000000-0000-7001-0000-000000000001",
      },
    });

    await processBucketCleanup(
      fakeJob({
        bucketId: bucket.id,
        deletedBy: "00000000-0000-7001-0000-000000000001",
        continuation: 0,
      })
    );

    // Every live version in that bucket should now be soft-deleted.
    const liveCount = await prisma.objectVersion.count({
      where: {
        object: { bucketId: bucket.id },
        deletedAt: null,
        isDeleteMarker: false,
        contentBlobHash: { not: null },
      },
    });
    expect(liveCount).toBe(0);
  });

  it("comes back for versions another writer holds locked", async () => {
    const bucket = await createTestBucket(token, { policy: "private" });
    for (let i = 0; i < 3; i++) {
      await uploadTestObject(
        token,
        bucket.name,
        `locked-${i}.txt`,
        createTestFile(
          `locked ${i} ${Date.now()}`,
          `locked-${i}.txt`,
          "text/plain"
        )
      );
    }
    const deletedBy = "00000000-0000-7001-0000-000000000001";
    await prisma.bucket.update({
      where: { id: bucket.id },
      data: { deletedAt: new Date(), deletedBy },
    });
    const versions = await prisma.objectVersion.findMany({
      where: { object: { bucketId: bucket.id } },
      orderBy: { id: "asc" },
    });

    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockHeld = new Promise<void>((r) => (locked = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT 1 FROM "files"."object_versions"
          WHERE "id" = ${versions[0].id}::uuid
          FOR UPDATE
        `;
        locked();
        await released;
      },
      { timeout: 20_000 }
    );
    await lockHeld;
    try {
      await processBucketCleanup(
        fakeJob({ bucketId: bucket.id, deletedBy, continuation: 0 })
      );
    } finally {
      release();
      await holder;
    }

    const continuations = (
      await getBucketCleanupQueue().getJobs(["delayed", "wait"], 0, -1)
    ).filter((j) => (j.data as { bucketId: number }).bucketId === bucket.id);
    expect(continuations).toHaveLength(1);
    expect(continuations[0].data).toEqual({
      bucketId: bucket.id,
      deletedBy,
      continuation: 1,
    });

    // The released versions' blobs are queued for cleanup already.
    const orphanJobs = await getOrphanBlobCleanupQueue().getJobs(
      ["wait", "delayed", "active", "completed"],
      0,
      -1
    );
    const queued = new Set(orphanJobs.map((j) => j.data.hash));
    for (const v of versions.slice(1)) {
      expect(queued.has(v.contentBlobHash)).toBe(true);
    }
    for (const j of orphanJobs) {
      if (versions.some((v) => v.contentBlobHash === j.data.hash)) {
        await j.remove().catch(() => undefined);
      }
    }
  });

  it("releases nothing in a bucket that is not deleted", async () => {
    const bucket = await createTestBucket(token, { policy: "private" });
    await uploadTestObject(
      token,
      bucket.name,
      "live.txt",
      createTestFile(`live ${Date.now()}`, "live.txt", "text/plain")
    );

    const res = await db.objects.releaseBucketBlobRefsBatch(
      bucket.id,
      "00000000-0000-7001-0000-000000000001",
      500
    );
    expect(res).toEqual({ processed: 0, freedHashes: [], hasMore: false });
    expect(await liveRefs(bucket.id)).toBe(1);
  });

  it("reconciles a deleted bucket whose cleanup was never enqueued", async () => {
    const bucket = await createTestBucket(token, { policy: "private" });
    for (let i = 0; i < 2; i++) {
      await uploadTestObject(
        token,
        bucket.name,
        `lost-${i}.txt`,
        createTestFile(`lost ${i} ${Date.now()}`, `lost-${i}.txt`, "text/plain")
      );
    }
    const deletedBy = "00000000-0000-7001-0000-000000000001";
    // Deleted two hours ago, its cleanup job lost.
    await prisma.bucket.update({
      where: { id: bucket.id },
      data: { deletedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), deletedBy },
    });

    const recent = await createTestBucket(token, { policy: "private" });
    await uploadTestObject(
      token,
      recent.name,
      "recent.txt",
      createTestFile(`recent ${Date.now()}`, "recent.txt", "text/plain")
    );
    await prisma.bucket.update({
      where: { id: recent.id },
      data: { deletedAt: new Date(), deletedBy },
    });

    await processBucketCleanupReconcile();

    const jobs = await getBucketCleanupQueue().getJobs(
      ["wait", "delayed", "active", "completed"],
      0,
      -1
    );
    const forBucket = (id: number) =>
      jobs.filter((j) => (j.data as BucketCleanupJobData).bucketId === id);
    const [job] = forBucket(bucket.id);
    expect(job?.data).toMatchObject({ bucketId: bucket.id, deletedBy });
    expect(job?.id).toMatch(new RegExp(`^bucket-cleanup__${bucket.id}__r`));
    // Still within the hour its own DELETE's cleanup has.
    expect(forBucket(recent.id)).toHaveLength(0);

    // The server's worker may be running it too; whichever gets there first
    // releases the refs.
    await processBucketCleanup(fakeJob(job.data as BucketCleanupJobData));
    await waitFor(async () => (await liveRefs(bucket.id)) === 0, 10_000);
  });

  it("schedules the reconciler", async () => {
    const queue = getBucketCleanupQueue();
    await queue.pause();
    try {
      await startBucketCleanup();
      const scheduler = await queue.getJobScheduler(
        "bucket-cleanup-reconcile-scheduler"
      );
      expect(scheduler?.every).toBe(6 * 60 * 60 * 1000);
    } finally {
      await stopBucketCleanup();
      await queue.resume();
    }
  });
});
