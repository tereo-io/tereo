// @module-tag int
// @module-tag files
// @module-tag job
import { enqueueThumbnailGeneration } from "../../jobs/thumbnailGeneration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getThumbnailGenerationQueue } from "../../jobs/queues.js";
import { prisma } from "../../utils/db/prisma.js";
import {
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObject,
} from "../support/files.js";

describe("enqueueThumbnailGeneration", () => {
  const jobsFor = async (parentObjectId: string) =>
    (
      await getThumbnailGenerationQueue().getJobs(
        ["wait", "delayed", "active", "completed", "failed"],
        0,
        -1
      )
    ).filter((j) => j.data.parentObjectId === parentObjectId);
  let token: string;
  let objectId: string | undefined;

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    // A job the worker holds can't be removed; it finishes as a no-op.
    if (objectId) {
      for (const job of await jobsFor(objectId)) {
        await job.remove().catch(() => undefined);
      }
    }
    await cleanupTestEntities();
  });

  it("queues a job for content uploaded again after other content", async () => {
    const bucket = await createTestBucket(token, { policy: "private" });
    const key = "thumb.txt";
    const a = `content A ${Date.now()}`;
    const b = `content B ${Date.now()}`;

    for (const content of [a, b, a]) {
      await uploadTestObject(
        token,
        bucket.name,
        key,
        createTestFile(content, key, "text/plain")
      );
      const object = await prisma.object.findFirstOrThrow({
        where: { bucketId: bucket.id, objectKey: key },
      });
      objectId = object.id;
      await enqueueThumbnailGeneration(object.id);
    }

    expect(await jobsFor(objectId!)).toHaveLength(3);
  });
});
