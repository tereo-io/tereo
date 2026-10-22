// @module-tag int
// @module-tag files
// @module-tag job
// @module-tag race
import { processDiskReconShard } from "../../jobs/diskBlobReconciliation.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRedisClient, redisKey } from "../../utils/redis.js";
import { getBlobPath } from "../../utils/storage.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomBytes } from "node:crypto";
import db from "../../utils/db/index.js";
import type { Job } from "bullmq";
import fs from "node:fs/promises";
import env from "../../env.js";
import path from "node:path";
import os from "node:os";
import {
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObject,
} from "../support/files.js";

describe("processDiskReconShard", () => {
  describe("diskBlobReconciliation shard", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    const exists = (p: string) =>
      fs.access(p).then(
        () => true,
        () => false
      );

    const runShard = (shard: string) =>
      processDiskReconShard({
        id: `test-${shard}`,
        data: { shard },
        updateProgress: async () => undefined,
      } as unknown as Job<{ shard: string }>);
    let token: string;
    let liveHash: string;
    let shard: string;
    let seenKey: string;
    // Orphans share the live blob's directory, so one shard run covers all.
    const orphan = () => liveHash.slice(0, 4) + randomBytes(30).toString("hex");
    const freshOrphan = { hash: "" };
    const agedOrphan = { hash: "" };

    beforeAll(async () => {
      token = await getTestAccessToken();
      const bucket = await createTestBucket(token, { policy: "private" });
      const key = "recon.txt";
      await uploadTestObject(
        token,
        bucket.name,
        key,
        createTestFile(
          `live ${randomBytes(8).toString("hex")}`,
          key,
          "text/plain"
        )
      );
      const version = await prisma.objectVersion.findFirst({
        where: { object: { bucketId: bucket.id, objectKey: key } },
      });
      liveHash = version!.contentBlobHash!;
      shard = liveHash.slice(0, 2);
      seenKey = `file-service:reconcile:seen-missing:${shard}:${liveHash.slice(2, 4)}`;

      freshOrphan.hash = orphan();
      agedOrphan.hash = orphan();
      for (const { hash } of [freshOrphan, agedOrphan]) {
        await fs.mkdir(path.dirname(getBlobPath(hash)), { recursive: true });
        await fs.writeFile(getBlobPath(hash), "orphan");
      }

      // Both the aged orphan and the live blob look as if first seen missing
      // two days ago; only the database row should save the live one.
      const redis = getRedisClient();
      const twoDaysAgo = String(Date.now() - 2 * DAY_MS);
      await redis.hset(seenKey, agedOrphan.hash, twoDaysAgo);
      await redis.hset(seenKey, liveHash, twoDaysAgo);

      await runShard(shard);
    });

    afterAll(async () => {
      await fs.rm(getBlobPath(freshOrphan.hash), { force: true });
      await fs.rm(getBlobPath(agedOrphan.hash), { force: true });
      await getRedisClient().hdel(seenKey, freshOrphan.hash, agedOrphan.hash);
      await cleanupTestEntities();
    });

    it("keeps a blob with a content_blobs row and clears its sighting", async () => {
      expect(await exists(getBlobPath(liveHash))).toBe(true);
      expect(await getRedisClient().hexists(seenKey, liveHash)).toBe(0);
    });

    it("keeps an orphan on its first sighting, recording when it was seen", async () => {
      expect(await exists(getBlobPath(freshOrphan.hash))).toBe(true);
      const seen = Number(
        await getRedisClient().hget(seenKey, freshOrphan.hash)
      );
      expect(Date.now() - seen).toBeLessThan(DAY_MS);
    });

    it("deletes an orphan first seen missing over a day ago", async () => {
      expect(await exists(getBlobPath(agedOrphan.hash))).toBe(false);
      expect(await getRedisClient().hexists(seenKey, agedOrphan.hash)).toBe(0);
    });
  });

  describe("diskBlobReconciliation against a concurrent upload", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    const exists = (p: string) =>
      fs.access(p).then(
        () => true,
        () => false
      );

    const runShard = (shard: string) =>
      processDiskReconShard({
        id: `test-${shard}`,
        data: { shard },
        updateProgress: async () => undefined,
      } as unknown as Job<{ shard: string }>);
    const hash = randomBytes(32).toString("hex");
    const shard = hash.slice(0, 2);
    const seenKey = `file-service:reconcile:seen-missing:${shard}:${hash.slice(2, 4)}`;

    afterAll(async () => {
      await prisma.contentBlob.deleteMany({ where: { hash } });
      await fs.rm(getBlobPath(hash), { force: true });
      await getRedisClient().del(seenKey);
    });

    it("leaves a file whose row an upload is creating under the blob's lock", async () => {
      await fs.mkdir(path.dirname(getBlobPath(hash)), { recursive: true });
      await fs.writeFile(getBlobPath(hash), "stale");
      await getRedisClient().hset(
        seenKey,
        hash,
        String(Date.now() - 2 * DAY_MS)
      );

      // Hold the lock as `attach` does: row inserted and file in place, not
      // yet committed, while the shard runs.
      let commit!: () => void;
      const committed = new Promise<void>((r) => (commit = r));
      let locked!: () => void;
      const lockHeld = new Promise<void>((r) => (locked = r));
      const upload = prisma.$transaction(
        async (tx) => {
          await db.contentBlobs.lockHash(hash, tx);
          await tx.contentBlob.create({
            data: {
              hash,
              sizeBytes: 5n,
              fsPath: getBlobPath(hash),
              wrappedDek: Buffer.alloc(16),
              iv: Buffer.alloc(12),
              masterKeyVersion: 1,
            },
          });
          locked();
          await committed;
        },
        { timeout: 20_000 }
      );
      await lockHeld;

      const run = runShard(shard);
      await new Promise((r) => setTimeout(r, 500));
      commit();
      await upload;
      await run;

      expect(await exists(getBlobPath(hash))).toBe(true);
    });
  });

  describe("diskBlobReconciliation over runs", () => {
    const runShard = (shard: string) =>
      processDiskReconShard({
        id: `test-${shard}`,
        data: { shard },
        updateProgress: async () => undefined,
      } as unknown as Job<{ shard: string }>);
    const storage = { previous: "", root: "" };
    const ceiling = { previous: 0 };
    // A shard of five unreferenced files, two checked per run.
    const shard = "f0";
    const sub = "0d";
    const names = Array.from(
      { length: 5 },
      (_, i) =>
        `${shard}${sub}${String(i).padStart(2, "0")}${randomBytes(29).toString("hex")}`
    ).sort();
    const seenKey = redisKey(
      `file-service:reconcile:seen-missing:${shard}:${sub}`
    );
    const cursorKey = redisKey(`file-service:reconcile:cursor:${shard}`);
    const sighted = async () => (await getRedisClient().hkeys(seenKey)).sort();

    beforeAll(async () => {
      storage.previous = env.FILE_SERVICE_STORAGE_PATH;
      ceiling.previous =
        env.FILE_SERVICE_DISK_RECONCILIATION_MAX_FILES_PER_SHARD;
      storage.root = await fs.mkdtemp(path.join(os.tmpdir(), "recon-"));
      env.FILE_SERVICE_STORAGE_PATH = storage.root;
      env.FILE_SERVICE_DISK_RECONCILIATION_MAX_FILES_PER_SHARD = 2;
      const dir = path.join(storage.root, "blobs", shard, sub);
      await fs.mkdir(dir, { recursive: true });
      for (const name of names) await fs.writeFile(path.join(dir, name), "x");
      await getRedisClient().del(seenKey, cursorKey);
    });

    afterAll(async () => {
      env.FILE_SERVICE_STORAGE_PATH = storage.previous;
      env.FILE_SERVICE_DISK_RECONCILIATION_MAX_FILES_PER_SHARD =
        ceiling.previous;
      await fs.rm(storage.root, { recursive: true, force: true });
      await getRedisClient().del(seenKey, cursorKey);
    });

    it("resumes where the last run's ceiling stopped it, and starts over once done", async () => {
      await runShard(shard);
      expect(await sighted()).toEqual(names.slice(0, 2));
      expect(await getRedisClient().get(cursorKey)).not.toBeNull();

      await runShard(shard);
      expect(await sighted()).toEqual(names.slice(0, 4));

      await runShard(shard);
      expect(await sighted()).toEqual(names);
      expect(await getRedisClient().get(cursorKey)).toBeNull();

      // Starting over: the first files are seen again, not skipped.
      await getRedisClient().del(seenKey);
      await runShard(shard);
      expect(await sighted()).toEqual(names.slice(0, 2));
    });
  });
});
