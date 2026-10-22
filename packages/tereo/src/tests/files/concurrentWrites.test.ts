import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRedisClient } from "../../utils/redis.js";
import { prisma } from "../../utils/db/prisma.js";
import { createHash, randomUUID } from "crypto";
import { execFileSync } from "child_process";
import fs from "fs/promises";
import axios from "axios";
import path from "path";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  testIdempotencyKey,
  uploadTestObject,
} from "../support/files.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Sends `requests` while a transaction holds `hold`'s locks, releasing them
 * together once all have had time to queue, so they reach what follows at
 * the same moment.
 */
async function releasedTogether<T>(
  hold: (tx: Tx) => Promise<unknown>,
  requests: Array<() => Promise<T>>
): Promise<T[]> {
  let pending!: Promise<T[]>;
  await prisma.$transaction(
    async (tx) => {
      await hold(tx);
      pending = Promise.all(requests.map((r) => r()));
      await sleep(1000);
    },
    { timeout: 30_000 }
  );
  return pending;
}

const lockBuckets = (ids: number[]) => (tx: Tx) =>
  tx.$queryRaw`SELECT 1 FROM "files"."buckets" WHERE "id" = ANY(${ids}::int[]) ORDER BY "id" FOR UPDATE`;

describe("concurrent writes", () => {
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

  const download = async (bucketName: string, key: string) =>
    axios.get<Buffer>(`${BASE_URL}/buckets/${bucketName}/objects/${key}`, {
      ...auth(),
      responseType: "arraybuffer",
    });

  describe("identical new content", () => {
    it("uploads to different buckets both succeed and share one blob", async () => {
      for (let round = 0; round < 3; round++) {
        const a = await createTestBucket(token);
        const b = await createTestBucket(token);
        const body = `same ${randomUUID()}`;
        const hash = createHash("sha256").update(body).digest("hex");

        const results = await releasedTogether(lockBuckets([a.id, b.id]), [
          () => uploadTestObject(token, a.name, "x.txt", createTestFile(body)),
          () => uploadTestObject(token, b.name, "y.txt", createTestFile(body)),
        ]);

        expect(results.map((r) => r.sizeBytes)).toEqual([
          String(body.length),
          String(body.length),
        ]);
        const blob = await prisma.contentBlob.findUniqueOrThrow({
          where: { hash },
        });
        expect(blob.refCount).toBe(2);
        await fs.access(blob.fsPath);
        for (const [bucket, key] of [
          [a.name, "x.txt"],
          [b.name, "y.txt"],
        ]) {
          const res = await download(bucket, key);
          expect(res.status).toBe(HTTP_STATUS.OK);
          expect(Buffer.from(res.data).toString()).toBe(body);
        }
      }
    });

    it("uploads to the same new key both succeed, the second overwriting", async () => {
      const bucket = await createTestBucket(token);
      const body = `same key ${randomUUID()}`;

      const put = async () => {
        const form = new FormData();
        form.append("file", new Blob([body], { type: "text/plain" }), "k.txt");
        const res = await fetch(
          `${BASE_URL}/buckets/${bucket.name}/objects/k.txt`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token}`,
              "Idempotency-Key": testIdempotencyKey(),
            },
            body: form,
          }
        );
        return {
          status: res.status,
          data: (await res.json()) as { id: string },
        };
      };
      const results = await Promise.all([put(), put()]);

      expect(results.map((r) => r.status).sort()).toEqual([
        HTTP_STATUS.OK,
        HTTP_STATUS.CREATED,
      ]);
      expect(results[0].data.id).toBe(results[1].data.id);
      const res = await download(bucket.name, "k.txt");
      expect(Buffer.from(res.data).toString()).toBe(body);
    });

    it("a failed write leaves the other's file in place", async () => {
      const ok = await createTestBucket(token);
      const full = await createTestBucket(token, { storageQuotaBytes: "1" });
      const body = `quota ${randomUUID()}`;
      const hash = createHash("sha256").update(body).digest("hex");

      const [stored, refused] = await releasedTogether(
        lockBuckets([ok.id, full.id]),
        [
          () =>
            uploadTestObject(token, ok.name, "keep.txt", createTestFile(body)),
          () =>
            uploadTestObject(
              token,
              full.name,
              "over.txt",
              createTestFile(body)
            ).catch((err: Error) => err),
        ]
      );

      expect(stored).toMatchObject({ key: "keep.txt" });
      expect(String(refused)).toMatch(/507/);
      const res = await download(ok.name, "keep.txt");
      expect(Buffer.from(res.data).toString()).toBe(body);
      const blob = await prisma.contentBlob.findUniqueOrThrow({
        where: { hash },
      });
      expect(blob.refCount).toBe(1);
    });
  });

  describe("multipart complete", () => {
    const startUpload = async (bucketName: string, body: string) => {
      const init = await axios.post(
        `${BASE_URL}/buckets/${bucketName}/multipart`,
        { objectKey: "mp.bin", contentType: "application/octet-stream" },
        auth()
      );
      expect(init.status).toBe(HTTP_STATUS.CREATED);
      const uploadId = init.data.uploadId as string;
      const part = await axios.put(
        `${BASE_URL}/buckets/${bucketName}/multipart/${uploadId}/parts/1`,
        Buffer.from(body),
        {
          ...auth(),
          headers: {
            ...auth().headers,
            "Content-Type": "application/octet-stream",
          },
        }
      );
      expect(part.status).toBe(HTTP_STATUS.OK);
      return { uploadId, parts: [{ partNumber: 1, etag: part.data.etag }] };
    };

    const complete = (
      bucketName: string,
      uploadId: string,
      parts: unknown,
      key: string
    ) =>
      axios.post(
        `${BASE_URL}/buckets/${bucketName}/multipart/${uploadId}/complete`,
        { parts },
        {
          ...auth(),
          headers: { ...auth().headers, "Idempotency-Key": key },
        }
      );

    it("runs once however long assembly takes, and a retry gets its result", async () => {
      const bucket = await createTestBucket(token);
      const { uploadId, parts } = await startUpload(
        bucket.name,
        `mp ${randomUUID()}`
      );
      const redis = getRedisClient();
      const claimKey = `file-service:multipart-complete:${uploadId}`;
      const first = testIdempotencyKey();

      // A slow assembly: the staged part becomes a FIFO, so reading it blocks
      // until the test writes the part's bytes in.
      const part = await prisma.multipartPart.findFirstOrThrow({
        where: { uploadId },
      });
      const partPath = path.resolve(part.fsPath);
      const partBytes = await fs.readFile(partPath);
      await fs.unlink(partPath);
      execFileSync("mkfifo", [partPath]);

      const pending = complete(bucket.name, uploadId, parts, first);
      await sleep(1000);

      const duringOtherKey = await complete(
        bucket.name,
        uploadId,
        parts,
        testIdempotencyKey()
      );
      const duringSameKey = await complete(bucket.name, uploadId, parts, first);

      // Shorten both claims; a renewal puts them back to a full TTL.
      const [idemKey] = await redis.keys(
        `file-service:idempotency:*multipart-complete:${uploadId}:${first}`
      );
      await redis.pexpire(claimKey, 8000);
      await redis.pexpire(idemKey, 8000);
      await sleep(6500);
      const renewedTtl = await redis.pttl(claimKey);
      const idemRenewedTtl = await redis.pttl(idemKey);

      await fs.writeFile(partPath, partBytes);
      const done = await pending;

      expect(duringOtherKey.status).toBe(HTTP_STATUS.CONFLICT);
      expect(duringOtherKey.data.error).toBe("multipart_complete_in_progress");
      expect(duringSameKey.status).toBe(HTTP_STATUS.CONFLICT);
      expect(renewedTtl).toBeGreaterThan(10_000);
      expect(idemRenewedTtl).toBeGreaterThan(10_000);
      expect(done.status).toBe(HTTP_STATUS.CREATED);
      expect(await redis.exists(claimKey)).toBe(0);

      const retry = await complete(
        bucket.name,
        uploadId,
        parts,
        testIdempotencyKey()
      );
      expect(retry.status).toBe(HTTP_STATUS.CREATED);
      expect(retry.data).toEqual(done.data);
      expect(
        await prisma.objectVersion.count({
          where: { objectId: done.data.id, deletedAt: null },
        })
      ).toBe(1);
    });
  });
});
