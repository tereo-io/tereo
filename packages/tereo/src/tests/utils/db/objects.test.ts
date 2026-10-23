// @module-tag int
// @module-tag files
// @module-tag race
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_USER_ID } from "../../../definitions/index.js";
import { prisma } from "../../../utils/db/prisma.js";
import db from "../../../utils/db/index.js";
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
  HTTP_STATUS,
  uploadTestObject,
} from "../../support/files.js";

describe("db.objects", () => {
  describe("batch deletes and their audit entries commit together", () => {
    let token: string;
    const fail = async () => {
      throw new Error("audit write failed");
    };

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    const live = (bucketId: number) =>
      prisma.object.count({ where: { bucketId, deletedAt: null } });

    it("a lifecycle batch is undone when its audit entry fails", async () => {
      const bucket = await createTestBucket(token);
      const obj = await uploadTestObject(
        token,
        bucket.name,
        "e.txt",
        createTestFile("e")
      );
      await expect(
        db.objects.removeExpiredObjects(
          bucket.id,
          [obj.id],
          { lastWrittenBefore: new Date(Date.now() + 60_000) },
          SYSTEM_USER_ID,
          fail
        )
      ).rejects.toThrow("audit write failed");
      expect(await live(bucket.id)).toBe(1);
    });

    it("batch deletes don't skip a row held only by a foreign-key check", async () => {
      const bucket = await createTestBucket(token);
      const a = await uploadTestObject(
        token,
        bucket.name,
        "k/a.txt",
        createTestFile("a")
      );
      const b = await uploadTestObject(
        token,
        bucket.name,
        "k/b.txt",
        createTestFile("b")
      );
      // The lock an insert referencing the object takes, as the access log
      // written after each request does.
      const holder = new Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(
          `SELECT 1 FROM "files"."objects" WHERE "id" = ANY($1::uuid[]) FOR KEY SHARE`,
          [[a.id, b.id]]
        );
        const expired = await db.objects.removeExpiredObjects(
          bucket.id,
          [a.id],
          { lastWrittenBefore: new Date(Date.now() + 60_000) },
          SYSTEM_USER_ID
        );
        const bulk = await db.objects.removeObjectsBulk(
          bucket.id,
          { kind: "prefix", prefix: "k/" },
          SYSTEM_USER_ID
        );
        expect(expired.map((o) => o.id)).toEqual([a.id]);
        expect(bulk.deletedObjects.map((o) => o.id)).toEqual([b.id]);
      } finally {
        await holder.query("ROLLBACK");
        await holder.end();
      }
    });

    it("a bulk delete batch is undone when its audit entry fails", async () => {
      const bucket = await createTestBucket(token);
      await uploadTestObject(
        token,
        bucket.name,
        "a/1.txt",
        createTestFile("1")
      );
      await expect(
        db.objects.removeObjectsBulk(
          bucket.id,
          { kind: "prefix", prefix: "a/" },
          SYSTEM_USER_ID,
          { onBatch: fail }
        )
      ).rejects.toThrow("audit write failed");
      expect(await live(bucket.id)).toBe(1);
    });

    it("a history purge batch is undone when its audit entry fails", async () => {
      const bucket = await createTestBucket(token);
      await prisma.bucket.update({
        where: { id: bucket.id },
        data: { versioningEnabled: true },
      });
      const obj = await uploadTestObject(
        token,
        bucket.name,
        "h.txt",
        createTestFile("h1")
      );
      await uploadTestObject(token, bucket.name, "h.txt", createTestFile("h2"));
      await expect(
        db.objectVersions.purgeNonCurrentBulk(bucket.id, SYSTEM_USER_ID, true, {
          onBatch: fail,
        })
      ).rejects.toThrow("audit write failed");
      expect(
        await prisma.objectVersion.count({
          where: { objectId: obj.id, deletedAt: null },
        })
      ).toBe(2);
    });

    it("a soft-delete purge batch is undone when its audit entry fails", async () => {
      const bucket = await createTestBucket(token);
      const obj = await uploadTestObject(
        token,
        bucket.name,
        "s.txt",
        createTestFile("s")
      );
      await prisma.object.update({
        where: { id: obj.id },
        data: { deletedAt: new Date(Date.now() - 60_000) },
      });
      await expect(
        db.objects.purgeSoftDeletedObjects(
          bucket.id,
          [obj.id],
          new Date(),
          false,
          fail
        )
      ).rejects.toThrow("audit write failed");
      expect(
        await prisma.object.findUnique({ where: { id: obj.id } })
      ).not.toBe(null);
    });
  });

  describe("blob refs released by racing purges", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const refCount = async (hash: string) =>
      (await prisma.contentBlob.findUniqueOrThrow({ where: { hash } }))
        .refCount;

    const liveRefs = (hash: string) =>
      prisma.objectVersion.count({
        where: {
          contentBlobHash: hash,
          deletedAt: null,
          isDeleteMarker: false,
        },
      });
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
      await uploadTestObject(
        token,
        bucket.name,
        "b.txt",
        createTestFile(shared)
      );
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
      await uploadTestObject(
        token,
        bucket.name,
        "b.txt",
        createTestFile(shared)
      );
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

  describe("files integrity", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
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

    const versionedBucket = async () => {
      const bucket = await createTestBucket(token);
      const res = await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        { versioningEnabled: true },
        auth()
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      return bucket as { id: number; name: string };
    };

    const upload = (bucketName: string, key: string, body: string) =>
      uploadTestObject(
        token,
        bucketName,
        key,
        createTestFile(body, key.split("/").pop(), "text/plain")
      );

    const versions = (objectId: string) =>
      prisma.objectVersion.findMany({
        where: { objectId, deletedAt: null },
        orderBy: { createdAt: "asc" },
      });

    describe("lifecycle re-checks what it read", () => {
      it("leaves an object whose expiry was cleared since the sweep read it", async () => {
        const bucket = await createTestBucket(token);
        const obj = await upload(bucket.name, "ttl.txt", `ttl ${randomUUID()}`);
        await prisma.object.update({
          where: { id: obj.id },
          data: { deleteAfter: null },
        });

        const removed = await db.objects.removeExpiredObjects(
          bucket.id,
          [obj.id],
          { deleteAfterBefore: new Date() },
          SYSTEM_USER_ID
        );
        expect(removed).toEqual([]);
        expect(
          (await prisma.object.findUniqueOrThrow({ where: { id: obj.id } }))
            .deletedAt
        ).toBeNull();
      });

      it("never deletes the object that took over an expired object's key", async () => {
        const bucket = await createTestBucket(token);
        const old = await upload(bucket.name, "k.txt", `old ${randomUUID()}`);
        await prisma.objectVersion.updateMany({
          where: { objectId: old.id },
          data: { createdAt: new Date(Date.now() - 10 * DAY_MS) },
        });
        await axios.delete(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${old.id}`,
          auth()
        );
        const fresh = await upload(bucket.name, "k.txt", `new ${randomUUID()}`);

        const removed = await db.objects.removeExpiredObjects(
          bucket.id,
          [old.id],
          { lastWrittenBefore: new Date(Date.now() - DAY_MS) },
          SYSTEM_USER_ID
        );
        expect(removed).toEqual([]);
        expect(
          (await prisma.object.findUniqueOrThrow({ where: { id: fresh.id } }))
            .deletedAt
        ).toBeNull();
      });

      it("does not purge an object undeleted since the sweep read it", async () => {
        const bucket = await versionedBucket();
        const obj = await upload(bucket.name, "u.txt", `u ${randomUUID()}`);
        const del = await axios.delete(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}`,
          auth()
        );
        expect(del.status).toBe(HTTP_STATUS.NO_CONTENT);
        await prisma.object.update({
          where: { id: obj.id },
          data: { deletedAt: new Date(Date.now() - 10 * DAY_MS) },
        });
        const [content] = await versions(obj.id);
        const restore = await axios.post(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}/versions/${content.id}/restore`,
          {},
          auth()
        );
        expect(restore.status).toBe(HTTP_STATUS.CREATED);

        const result = await db.objects.purgeSoftDeletedObjects(
          bucket.id,
          [obj.id],
          new Date(Date.now() - DAY_MS),
          true
        );
        expect(result.purgedIds).toEqual([]);
        expect(
          await prisma.object.findUnique({ where: { id: obj.id } })
        ).not.toBeNull();
      });
    });
  });
});
