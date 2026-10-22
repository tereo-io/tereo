import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import { randomUUID } from "crypto";
import { Client } from "pg";
import axios from "axios";
import {
  BASE_URL,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  getTestUserId,
  uploadTestObject,
} from "../support/files.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const refCount = async (hash: string) =>
  (await prisma.contentBlob.findUniqueOrThrow({ where: { hash } })).refCount;

const liveRefs = (hash: string) =>
  prisma.objectVersion.count({
    where: { contentBlobHash: hash, deletedAt: null, isDeleteMarker: false },
  });

describe("blob refs released by racing purges", () => {
  let token: string;
  const auth = () => ({
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("releases a version once when the soft-deleted purge races the history purge", async () => {
    const bucket = await createTestBucket(token);
    await axios.put(
      `${BASE_URL}/buckets/${bucket.name}`,
      { versioningEnabled: true },
      auth()
    );
    const shared = `shared ${randomUUID()}`;
    const a = await uploadTestObject(
      token,
      bucket.name,
      "a.txt",
      createTestFile(shared)
    );
    await uploadTestObject(
      token,
      bucket.name,
      "a.txt",
      createTestFile(`other ${randomUUID()}`)
    );
    await uploadTestObject(token, bucket.name, "b.txt", createTestFile(shared));
    const del = await axios.delete(
      `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${a.id}`,
      auth()
    );
    expect(del.status).toBe(204);

    const sharedVersion = await prisma.objectVersion.findFirstOrThrow({
      where: { objectId: a.id, isCurrent: false, isDeleteMarker: false },
      orderBy: { createdAt: "asc" },
    });
    const hash = sharedVersion.contentBlobHash!;
    expect(await refCount(hash)).toBe(2);
    await prisma.object.update({
      where: { id: a.id },
      data: { deletedAt: new Date(Date.now() - 10 * 86_400_000) },
    });

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inBatch!: () => void;
    const batchStarted = new Promise<void>((r) => (inBatch = r));

    const historyPurge = db.objectVersions.purgeNonCurrentBulk(
      bucket.id,
      getTestUserId(),
      true,
      {
        onBatch: async () => {
          inBatch();
          await gate;
        },
      }
    );
    await batchStarted;
    const lifecyclePurge = db.objects.purgeSoftDeletedObjects(
      bucket.id,
      [a.id],
      new Date(Date.now() - 86_400_000),
      true
    );
    // Let the lifecycle purge reach the versions the history purge holds.
    await sleep(500);
    release();
    await Promise.all([historyPurge, lifecyclePurge]);

    expect(await liveRefs(hash)).toBe(1);
    expect(await refCount(hash)).toBe(1);
  });

  it("does not release a non-versioned object's version a concurrent cleanup released", async () => {
    const bucket = await createTestBucket(token);
    const shared = `shared ${randomUUID()}`;
    const a = await uploadTestObject(
      token,
      bucket.name,
      "a.txt",
      createTestFile(shared)
    );
    await uploadTestObject(token, bucket.name, "b.txt", createTestFile(shared));
    const version = await prisma.objectVersion.findFirstOrThrow({
      where: { objectId: a.id, isCurrent: true },
    });
    const hash = version.contentBlobHash!;
    expect(await refCount(hash)).toBe(2);

    // Another releaser (as bucket cleanup does) holding the version mid-release.
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        `UPDATE "files"."object_versions" SET "deleted_at" = NOW() WHERE "id" = $1`,
        [version.id]
      );
      await holder.query(
        `UPDATE "files"."content_blobs" SET "ref_count" = "ref_count" - 1 WHERE "hash" = $1`,
        [hash]
      );
      const removal = db.objects.removeObjectById(
        bucket.id,
        a.id,
        getTestUserId()
      );
      await sleep(500);
      await holder.query("COMMIT");
      const result = await removal;
      expect(result.releasedBlobHashes).toEqual([]);
    } finally {
      await holder.end();
    }

    expect(await liveRefs(hash)).toBe(1);
    expect(await refCount(hash)).toBe(1);
  });

  it("refuses to remove an object of a deleted bucket", async () => {
    const bucket = await createTestBucket(token);
    const a = await uploadTestObject(
      token,
      bucket.name,
      "a.txt",
      createTestFile(`x ${randomUUID()}`)
    );
    await prisma.bucket.update({
      where: { id: bucket.id },
      data: { deletedAt: new Date() },
    });

    await expect(
      db.objects.removeObjectById(bucket.id, a.id, getTestUserId())
    ).rejects.toThrow("bucket deleted");
  });
});
