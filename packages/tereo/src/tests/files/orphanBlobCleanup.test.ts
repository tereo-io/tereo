import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getOrphanBlobCleanupQueue } from "../../jobs/queues.js";
import { getBlobPath } from "../../utils/storage.js";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import env from "../../env.js";
import fs from "fs/promises";
import {
  enqueueOrphanBlobCleanup,
  processOrphanBlobCleanup,
} from "../../jobs/orphanBlobCleanup.js";
import {
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObject,
} from "../support/files.js";

const jobsFor = async (hash: string) => {
  const jobs = await getOrphanBlobCleanupQueue().getJobs(
    ["wait", "delayed", "active", "completed", "failed"],
    0,
    -1
  );
  return jobs.filter((j) => j.data.hash === hash);
};

describe("orphanBlobCleanup worker", () => {
  let token: string;
  const hashes: string[] = [];

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    for (const hash of hashes) {
      for (const job of await jobsFor(hash)) await job.remove();
    }
    await cleanupTestEntities();
  });

  const orphanedBlob = async (key: string) => {
    const bucket = await createTestBucket(token, { policy: "private" });
    await uploadTestObject(
      token,
      bucket.name,
      key,
      createTestFile(`payload ${key} ${Date.now()}`, key, "text/plain")
    );
    const version = await prisma.objectVersion.findFirst({
      where: { object: { bucketId: bucket.id, objectKey: key } },
    });
    const hash = version!.contentBlobHash!;
    hashes.push(hash);
    await prisma.contentBlob.update({
      where: { hash },
      data: { refCount: 0, orphanedAt: new Date() },
    });
    return hash;
  };

  it("silently skips a hash whose row doesn't exist (happy path)", async () => {
    // claimOrphan returns null for a missing hash; processor should be a
    // clean no-op.
    await expect(
      processOrphanBlobCleanup(
        "0000000000000000000000000000000000000000000000000000000000000000"
      )
    ).resolves.toBeUndefined();
  });

  it("silently skips a hash whose orphan grace has not elapsed (error path)", async () => {
    // Upload an object then delete it so the blob is orphan-but-within-grace.
    // The cleanup must not purge it.
    const bucket = await createTestBucket(token, { policy: "private" });
    const key = "orphan.txt";
    const upload = await uploadTestObject(
      token,
      bucket.name,
      key,
      createTestFile("payload", key, "text/plain")
    );

    const version = await prisma.objectVersion.findFirst({
      where: { object: { bucketId: bucket.id, objectKey: key } },
    });
    const hash = version!.contentBlobHash!;

    // Simulate the delete path's refcount drop + orphan marker.
    await prisma.contentBlob.update({
      where: { hash },
      data: { refCount: 0, orphanedAt: new Date() },
    });

    // The grace window is env-configured; we're well within it. The processor
    // should skip (returns undefined) and leave the row intact.
    await expect(processOrphanBlobCleanup(hash)).resolves.toBeUndefined();
    const still = await prisma.contentBlob.findUnique({ where: { hash } });
    expect(still).not.toBeNull();

    // Avoid unused-var lint
    expect(upload.etag).toBeDefined();
  });

  it("checks again later when the blob is still orphaned but within grace", async () => {
    const hash = await orphanedBlob("recheck.txt");
    await processOrphanBlobCleanup(hash);
    const jobs = await jobsFor(hash);
    expect(jobs.map((j) => j.id)).toEqual([
      expect.stringMatching(new RegExp(`^orphan__${hash}__\\d+__r\\d+$`)),
    ]);
    expect(await jobs[0].isDelayed()).toBe(true);
  });

  it("gives a blob orphaned again its own job", async () => {
    const hash = await orphanedBlob("reorphan.txt");
    await enqueueOrphanBlobCleanup(hash);
    await enqueueOrphanBlobCleanup(hash);
    expect(await jobsFor(hash)).toHaveLength(1);

    // Revived and released again: a later orphaned_at.
    await prisma.contentBlob.update({
      where: { hash },
      data: { orphanedAt: new Date(Date.now() + 1000) },
    });
    await enqueueOrphanBlobCleanup(hash);
    expect(await jobsFor(hash)).toHaveLength(2);
  });

  it("enqueues nothing for a blob that is referenced again", async () => {
    const hash = await orphanedBlob("revived.txt");
    await prisma.contentBlob.update({
      where: { hash },
      data: { refCount: 1, orphanedAt: null },
    });
    await enqueueOrphanBlobCleanup(hash);
    expect(await jobsFor(hash)).toHaveLength(0);
  });

  it("repairs the count of a blob a live version references instead of deleting it", async () => {
    const hash = await orphanedBlob("drifted.txt");
    const pastGrace = new Date(
      Date.now() - (env.FILE_SERVICE_ORPHAN_BLOB_GRACE_SECONDS + 60) * 1000
    );
    await prisma.contentBlob.update({
      where: { hash },
      data: { orphanedAt: pastGrace },
    });

    await processOrphanBlobCleanup(hash);

    expect(
      await prisma.contentBlob.findUnique({ where: { hash } })
    ).toMatchObject({ refCount: 1, orphanedAt: null });
    await expect(fs.access(getBlobPath(hash))).resolves.toBeUndefined();
    expect(
      await prisma.objectVersion.count({ where: { contentBlobHash: hash } })
    ).toBe(1);
  });

  it("refuses a reference count below zero", async () => {
    const hash = await orphanedBlob("negative.txt");
    await expect(
      prisma.contentBlob.update({ where: { hash }, data: { refCount: -1 } })
    ).rejects.toThrow();
    await expect(
      prisma.$transaction((tx) => db.contentBlobs.decRef(hash, tx))
    ).rejects.toThrow(/content_blobs_ref_count_nonnegative/);
    await expect(
      prisma.$transaction((tx) => db.contentBlobs.decRefMany([hash], tx))
    ).rejects.toThrow(/content_blobs_ref_count_nonnegative/);
    expect(
      await prisma.contentBlob.findUnique({ where: { hash } })
    ).toMatchObject({ refCount: 0 });
  });
});
