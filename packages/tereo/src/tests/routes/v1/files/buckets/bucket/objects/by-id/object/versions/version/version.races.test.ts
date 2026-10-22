// @module-tag int
// @module-tag files
// @module-tag race
import { prisma } from "../../../../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import FormData from "form-data";
import axios from "axios";
import {
  lockWaiters,
  untilQueued,
} from "../../../../../../../../../../../tests/support/dbLocks.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  testIdempotencyKey,
  uploadTestObject,
} from "../../../../../../../../../../support/files.js";

describe("POST /v1/files/buckets/:name/objects/by-id/:id/versions/:versionId/restore and DELETE /v1/files/buckets/:name/objects/by-id/:id/versions/:versionId", () => {
  describe("object write lock order", () => {
    type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

    /**
     * Holds a transaction open while `request` is sent: `hold` takes its locks
     * first, and `whileQueued` runs in it once the request has had time to queue
     * behind them. The request finishes after the transaction commits.
     */
    async function queuedBehind<T>(
      hold: (tx: Tx) => Promise<unknown>,
      request: () => Promise<T>,
      whileQueued: (tx: Tx) => Promise<void> = async () => {}
    ): Promise<T> {
      let pending!: Promise<T>;
      await prisma.$transaction(
        async (tx) => {
          await hold(tx);
          const baseline = await lockWaiters();
          pending = request();
          await untilQueued(baseline, 1);
          await whileQueued(tx);
        },
        { timeout: 30_000 }
      );
      return pending;
    }

    const lockBucket = (bucketId: number) => (tx: Tx) =>
      tx.$queryRaw`SELECT 1 FROM "files"."buckets" WHERE "id" = ${bucketId} FOR UPDATE`;

    /** The blob's row, if no other transaction holds it. */
    const blobRowIfFree = (tx: Tx, hash: string) =>
      tx.$queryRaw<{ hash: string }[]>`
    SELECT "hash" FROM "files"."content_blobs"
    WHERE "hash" = ${hash}
    FOR UPDATE SKIP LOCKED
  `;
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

    const putObject = (bucketName: string, key: string, body: string) => {
      const form = new FormData();
      form.append("file", Buffer.from(body), {
        filename: "o.txt",
        contentType: "text/plain",
      });
      return axios.put(
        `${BASE_URL}/buckets/${bucketName}/objects/${key}`,
        form,
        {
          headers: {
            ...auth().headers,
            "Idempotency-Key": testIdempotencyKey(),
            ...form.getHeaders(),
          },
          validateStatus: () => true,
        }
      );
    };

    const versionedObject = async () => {
      const bucket = (await createTestBucket(token)) as {
        id: number;
        name: string;
      };
      await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        { versioningEnabled: true },
        auth()
      );
      const firstBody = `v1 ${randomUUID()}`;
      const obj = await uploadTestObject(
        token,
        bucket.name,
        "o.txt",
        createTestFile(firstBody)
      );
      await uploadTestObject(
        token,
        bucket.name,
        "o.txt",
        createTestFile(`v2 ${randomUUID()}`)
      );
      const [first] = await prisma.objectVersion.findMany({
        where: { objectId: obj.id, deletedAt: null },
        orderBy: { createdAt: "asc" },
      });
      return { bucket, objectId: obj.id, first, firstBody };
    };

    it("restore waits for the bucket before it locks the blob", async () => {
      const { bucket, objectId, first } = await versionedObject();
      let free: unknown[] = [];

      const restore = await queuedBehind(
        lockBucket(bucket.id),
        () =>
          axios.post(
            `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}/versions/${first.id}/restore`,
            {},
            auth()
          ),
        async (tx) => {
          free = await blobRowIfFree(tx, first.contentBlobHash!);
        }
      );

      expect(free).toHaveLength(1);
      expect(restore.status).toBe(HTTP_STATUS.CREATED);
    });

    it("an upload and a restore of the same content both complete", async () => {
      const { bucket, objectId, first, firstBody } = await versionedObject();
      for (let i = 0; i < 5; i++) {
        const [restore, upload] = await Promise.all([
          axios.post(
            `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}/versions/${first.id}/restore`,
            {},
            auth()
          ),
          uploadTestObject(
            token,
            bucket.name,
            `copy-${i}.txt`,
            createTestFile(firstBody)
          ),
        ]);
        expect(restore.status).toBe(HTTP_STATUS.CREATED);
        expect(upload.id).toBeTruthy();
      }
    });

    describe("versioning is read under the bucket lock", () => {
      const turnVersioningOff = (bucketId: number) => (tx: Tx) =>
        tx.$executeRaw`UPDATE "files"."buckets" SET "versioning_enabled" = false WHERE "id" = ${bucketId}`;

      it("restore refuses once versioning was turned off while it waited", async () => {
        const { bucket, objectId, first } = await versionedObject();

        const restore = await queuedBehind(turnVersioningOff(bucket.id), () =>
          axios.post(
            `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}/versions/${first.id}/restore`,
            {},
            auth()
          )
        );

        expect(restore.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect((restore.data as { error: string }).error).toBe(
          "versioning_disabled"
        );
      });
    });

    describe("releasing a version's ref locks the bucket before the blob", () => {
      /**
       * Queues an upload of `firstBody` and then `release` behind a held bucket
       * lock: the upload waits for the bucket first, so it takes the bucket
       * before the blob both write once the lock is let go.
       */
      const raceUploadOfReleasedContent = async <T>(
        bucket: { id: number; name: string },
        firstBody: string,
        release: () => Promise<T>
      ) => {
        let upload!: ReturnType<typeof putObject>;
        let released!: Promise<T>;
        await prisma.$transaction(
          async (tx) => {
            await lockBucket(bucket.id)(tx);
            const baseline = await lockWaiters();
            upload = putObject(bucket.name, "copy.txt", firstBody);
            await untilQueued(baseline, 1);
            released = release();
            await untilQueued(baseline, 2);
          },
          { timeout: 30_000 }
        );
        return await Promise.all([upload, released]);
      };

      it("a version delete and an upload of its content both complete", async () => {
        const { bucket, objectId, first, firstBody } = await versionedObject();

        const [upload, del] = await raceUploadOfReleasedContent(
          bucket,
          firstBody,
          () =>
            axios.delete(
              `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}/versions/${first.id}`,
              auth()
            )
        );

        expect(upload.status).toBe(HTTP_STATUS.CREATED);
        expect(del.status).toBe(HTTP_STATUS.NO_CONTENT);
      });
    });
  });

  describe("files integrity", () => {
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

    const usage = async (bucketId: number) =>
      (await prisma.bucket.findUniqueOrThrow({ where: { id: bucketId } }))
        .currentUsageBytes;

    const versions = (objectId: string) =>
      prisma.objectVersion.findMany({
        where: { objectId, deletedAt: null },
        orderBy: { createdAt: "asc" },
      });

    describe("deleting a version", () => {
      it("releases its blob ref once under concurrent deletes and refunds its usage", async () => {
        const bucket = await versionedBucket();
        const shared = `shared ${randomUUID()}`;
        const a = await upload(bucket.name, "a.txt", shared);
        await upload(bucket.name, "b.txt", shared);
        await upload(bucket.name, "a.txt", `a v2 ${randomUUID()}`);

        const [old] = await versions(a.id);
        const hash = old.contentBlobHash!;
        const size = BigInt(Buffer.byteLength(shared));
        expect(
          (await prisma.contentBlob.findUniqueOrThrow({ where: { hash } }))
            .refCount
        ).toBe(2);
        const before = await usage(bucket.id);

        const url = `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${a.id}/versions/${old.id}`;
        const statuses = (
          await Promise.all([
            axios.delete(url, auth()),
            axios.delete(url, auth()),
          ])
        )
          .map((r) => r.status)
          .sort();
        expect(statuses).toEqual([
          HTTP_STATUS.NO_CONTENT,
          HTTP_STATUS.NOT_FOUND,
        ]);

        expect(
          (await prisma.contentBlob.findUniqueOrThrow({ where: { hash } }))
            .refCount
        ).toBe(1);
        expect(await usage(bucket.id)).toBe(before - size);
      });

      it("a version branched by PATCH is charged, so deleting the old one leaves usage right", async () => {
        const bucket = await versionedBucket();
        const body = `branch ${randomUUID()}`;
        const size = BigInt(Buffer.byteLength(body));
        const obj = await upload(bucket.name, "b.txt", body);
        expect(await usage(bucket.id)).toBe(size);

        const patch = await axios.patch(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}`,
          { tags: ["branched"], createNewVersion: true },
          auth()
        );
        expect(patch.status).toBe(HTTP_STATUS.OK);
        expect(await usage(bucket.id)).toBe(2n * size);

        const [old] = await versions(obj.id);
        const del = await axios.delete(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}/versions/${old.id}`,
          auth()
        );
        expect(del.status).toBe(HTTP_STATUS.NO_CONTENT);
        expect(await usage(bucket.id)).toBe(size);
      });
    });
  });
});
