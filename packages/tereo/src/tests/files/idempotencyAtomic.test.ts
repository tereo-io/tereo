import { withIdempotency } from "../../utils/uploadIdempotency.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import { randomUUID } from "crypto";
import {
  discardStagedFile,
  getBlobPath,
  saveBlobBuffer,
} from "../../utils/storage.js";
import {
  cleanupTestEntities,
  createTestBucket,
  getTestAccessToken,
  getTestUserId,
  testIdempotencyKey,
} from "../support/files.js";

describe("idempotency record in the write's transaction", () => {
  let bucket: { id: number; name: string };

  beforeAll(async () => {
    bucket = await createTestBucket(await getTestAccessToken());
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  // The shape of the upload handler: the object write, then the record,
  // in one transaction.
  const upload = (recordUserId: string, idempotencyKey: string, key: string) =>
    withIdempotency<{ id: string }>(
      {
        scope: `test:${bucket.id}`,
        key: idempotencyKey,
        requestHash: "hash",
        userId: recordUserId,
      },
      async (persist) => {
        const saved = await saveBlobBuffer(Buffer.from(`body ${key}`));
        try {
          return await db.$transaction(async (tx) => {
            const upsert = await db.objects.upsertWithBlob(
              {
                bucketId: bucket.id,
                objectKey: key,
                contentType: "text/plain",
                contentBlobHash: saved.hash,
                sizeBytes: BigInt(saved.sizeBytes),
                etag: saved.etag,
                createdBy: getTestUserId(),
                stagedPath: saved.stagedPath,
              },
              getBlobPath(saved.hash),
              saved.keyMaterial,
              tx
            );
            const result = { status: 201, body: { id: upsert.object.id } };
            await persist(tx, result);
            return result;
          });
        } catch (err) {
          await db.contentBlobs.releaseStaged(saved);
          throw err;
        } finally {
          await discardStagedFile(saved.stagedPath);
        }
      }
    );

  it("rolls the write back when the record cannot be stored, so a retry writes once", async () => {
    const key = `atomic-${randomUUID()}.txt`;
    const idempotencyKey = testIdempotencyKey();
    const usage = async () =>
      (await prisma.bucket.findUniqueOrThrow({ where: { id: bucket.id } }))
        .currentUsageBytes;
    const before = await usage();

    // A record whose creator is no user fails its foreign key.
    await expect(upload(randomUUID(), idempotencyKey, key)).rejects.toThrow();
    expect(
      await prisma.object.count({
        where: { bucketId: bucket.id, objectKey: key },
      })
    ).toBe(0);
    expect(await usage()).toBe(before);

    const first = await upload(getTestUserId(), idempotencyKey, key);
    expect(first.replayed).toBe(false);
    const replay = await upload(getTestUserId(), idempotencyKey, key);
    expect(replay).toMatchObject({ replayed: true, body: first.body });

    const versions = await prisma.objectVersion.count({
      where: { object: { bucketId: bucket.id, objectKey: key } },
    });
    expect(versions).toBe(1);
  });
});
