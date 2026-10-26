// @module-tag int
// @module-tag files
// @module-tag job
import { processOrphanBlobBackstop } from "../../jobs/orphanBlobBackstop.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getOrphanBlobCleanupQueue } from "../../jobs/queues.js";
import { prisma } from "../../utils/db/prisma.js";
import {
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObject,
} from "../support/files.js";

describe("processOrphanBlobBackstop", () => {
  let token: string;

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("completes cleanly on an empty candidate set (happy path)", async () => {
    // Nothing orphaned past the grace window — loop exits immediately.
    await expect(processOrphanBlobBackstop()).resolves.toBeUndefined();
  });

  it("walks candidates and re-enqueues without throwing (error path)", async () => {
    // Seed an orphan whose orphaned_at is well before the grace window.
    const bucket = await createTestBucket(token, { policy: "private" });
    const key = "backstop.txt";
    await uploadTestObject(
      token,
      bucket.name,
      key,
      createTestFile("payload", key, "text/plain")
    );

    const version = await prisma.objectVersion.findFirst({
      where: { object: { bucketId: bucket.id, objectKey: key } },
    });
    const hash = version!.contentBlobHash!;
    await prisma.contentBlob.update({
      where: { hash },
      data: {
        refCount: 0,
        orphanedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    });

    // Should find the orphan and enqueue without throwing.
    await expect(processOrphanBlobBackstop()).resolves.toBeUndefined();
  });

  it("enqueues past an earlier job for the same orphaning", async () => {
    const bucket = await createTestBucket(token, { policy: "private" });
    const key = "backstop-retained.txt";
    await uploadTestObject(
      token,
      bucket.name,
      key,
      createTestFile(`retained ${Date.now()}`, key, "text/plain")
    );
    const version = await prisma.objectVersion.findFirst({
      where: { object: { bucketId: bucket.id, objectKey: key } },
    });
    const hash = version!.contentBlobHash!;
    const orphanedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await prisma.contentBlob.update({
      where: { hash },
      data: { refCount: 0, orphanedAt },
    });

    // An earlier job that ran without deleting the blob keeps its id.
    const queue = getOrphanBlobCleanupQueue();
    const earlier = await queue.add(
      "orphan-blob-cleanup",
      { hash },
      { jobId: `orphan__${hash}__${orphanedAt.getTime()}`, delay: 60_000 }
    );

    await processOrphanBlobBackstop();
    const jobs = (
      await queue.getJobs(
        ["wait", "delayed", "active", "completed", "failed"],
        0,
        -1
      )
    ).filter((j) => j.data.hash === hash);
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    await earlier.remove();
  });
});
