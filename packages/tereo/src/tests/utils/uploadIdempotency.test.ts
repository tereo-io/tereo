// @module-tag int
// @module-tag files
// @module-tag race
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withIdempotency } from "../../utils/uploadIdempotency.js";
import { FIXTURE_USER_IDS } from "../support/principals.js";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import { randomUUID } from "crypto";
import FormData from "form-data";
import axios from "axios";
import {
  discardStagedFile,
  getBlobPath,
  saveBlobBuffer,
} from "../../utils/storage.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  getTestUserId,
  testIdempotencyKey,
} from "../support/files.js";

describe("withIdempotency", () => {
  describe("Upload idempotency", () => {
    const putObject = async (
      token: string,
      bucketName: string,
      objectKey: string,
      content: string,
      idempotencyKey: string | undefined,
      contentType = "text/plain"
    ) => {
      const file = createTestFile(content, "idem.txt", contentType);
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        ...formData.getHeaders(),
      };
      if (idempotencyKey !== undefined) {
        headers["Idempotency-Key"] = idempotencyKey;
      }
      return axios.put(
        `${BASE_URL}/buckets/${bucketName}/objects/${objectKey}`,
        formData,
        { headers, validateStatus: () => true }
      );
    };
    let token: string;
    let bucket: { id: number; name: string };

    beforeAll(async () => {
      token = await getTestAccessToken();
      bucket = await createTestBucket(token, { policy: "private" });
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    it("requires the Idempotency-Key header on upload PUT", async () => {
      const res = await putObject(
        token,
        bucket.name,
        `missing-${Date.now()}.txt`,
        "x",
        undefined
      );
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(res.data.error).toBe("idempotency_key_required");
    });

    it("rejects an empty Idempotency-Key", async () => {
      const res = await putObject(
        token,
        bucket.name,
        `empty-${Date.now()}.txt`,
        "x",
        ""
      );
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(res.data.error).toBe("idempotency_key_required");
    });

    it("replays the first response on retry with the same key + same payload", async () => {
      const key = testIdempotencyKey();
      const objectKey = `replay-${Date.now()}.txt`;
      const content = "original content";

      const first = await putObject(
        token,
        bucket.name,
        objectKey,
        content,
        key
      );
      expect(first.status).toBe(HTTP_STATUS.CREATED);
      const firstId = first.data.id;
      expect(firstId).toBeDefined();
      expect(first.headers["idempotency-replay"]).toBeUndefined();

      const second = await putObject(
        token,
        bucket.name,
        objectKey,
        content,
        key
      );
      expect(second.status).toBe(HTTP_STATUS.CREATED);
      expect(second.data.id).toBe(firstId);
      expect(second.headers["idempotency-replay"]).toBe("true");
    });

    it("returns 422 when the same key is reused with different content", async () => {
      const key = testIdempotencyKey();
      const objectKey = `conflict-${Date.now()}.txt`;

      const first = await putObject(token, bucket.name, objectKey, "v1", key);
      expect(first.status).toBe(HTTP_STATUS.CREATED);

      const second = await putObject(token, bucket.name, objectKey, "v2", key);
      expect(second.status).toBe(422);
      expect(second.data.error).toBe("idempotency_key_conflict");
    });

    it("returns 422 when the same key and bytes are reused with another content type", async () => {
      const key = testIdempotencyKey();
      const objectKey = `conflict-type-${Date.now()}.json`;
      const content = '{"a":1}';

      const first = await putObject(
        token,
        bucket.name,
        objectKey,
        content,
        key
      );
      expect(first.status).toBe(HTTP_STATUS.CREATED);

      const second = await putObject(
        token,
        bucket.name,
        objectKey,
        content,
        key,
        "application/json"
      );
      expect(second.status).toBe(422);
      expect(second.data.error).toBe("idempotency_key_conflict");
    });

    it("does not dedupe across different idempotency keys", async () => {
      const objectKey = `different-keys-${Date.now()}.txt`;
      const a = await putObject(
        token,
        bucket.name,
        objectKey,
        "content",
        testIdempotencyKey()
      );
      const b = await putObject(
        token,
        bucket.name,
        objectKey,
        "content",
        testIdempotencyKey()
      );
      expect(a.status).toBe(HTTP_STATUS.CREATED);
      expect([HTTP_STATUS.CREATED, HTTP_STATUS.OK]).toContain(b.status);
      // Both calls update the same objectKey — the id is stable.
      expect(b.data.id).toBe(a.data.id);
      // Neither is a replay since they used distinct keys.
      expect(a.headers["idempotency-replay"]).toBeUndefined();
      expect(b.headers["idempotency-replay"]).toBeUndefined();
    });

    it("answers a concurrent call with 409 idempotency_request_in_progress", async () => {
      const input = {
        scope: `test:in-progress:${Date.now()}`,
        key: testIdempotencyKey(),
        requestHash: "hash",
        userId: FIXTURE_USER_IDS[0],
      };
      let started!: () => void;
      const startedP = new Promise<void>((resolve) => (started = resolve));
      let release!: () => void;
      const releaseP = new Promise<void>((resolve) => (release = resolve));

      // The first call holds the claim and then fails, so nothing is persisted.
      const first = withIdempotency(input, async () => {
        started();
        await releaseP;
        throw new Error("released");
      });
      await startedP;

      await expect(
        withIdempotency(input, async () => ({ status: 201, body: {} }))
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "idempotency_request_in_progress",
      });

      release();
      await expect(first).rejects.toThrow("released");
    });
  });

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
    const upload = (
      recordUserId: string,
      idempotencyKey: string,
      key: string
    ) =>
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
});
