import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import FormData from "form-data";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  testIdempotencyKey,
  uploadTestObject,
} from "./utils/test-helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
      pending = request();
      await sleep(1000);
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

describe("object write lock order", () => {
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
    return axios.put(`${BASE_URL}/buckets/${bucketName}/objects/${key}`, form, {
      headers: {
        ...auth().headers,
        "Idempotency-Key": testIdempotencyKey(),
        ...form.getHeaders(),
      },
      validateStatus: () => true,
    });
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

  it("a branching PATCH waits for the bucket before it locks the blob", async () => {
    const { bucket, objectId } = await versionedObject();
    const current = await prisma.objectVersion.findFirstOrThrow({
      where: { objectId, isCurrent: true },
    });
    let free: unknown[] = [];

    const patch = await queuedBehind(
      lockBucket(bucket.id),
      () =>
        axios.patch(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}`,
          { tags: ["b"], createNewVersion: true },
          auth()
        ),
      async (tx) => {
        free = await blobRowIfFree(tx, current.contentBlobHash!);
      }
    );

    expect(free).toHaveLength(1);
    expect(patch.status).toBe(HTTP_STATUS.OK);
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

  it("two overwrites swapping content between objects both complete", async () => {
    const a = await createTestBucket(token);
    const b = await createTestBucket(token);
    for (let i = 0; i < 10; i++) {
      const one = `one ${randomUUID()}`;
      const two = `two ${randomUUID()}`;
      await putObject(a.name, "x.txt", one);
      await putObject(b.name, "y.txt", two);
      // Each attaches the content the other releases.
      const [x, y] = await Promise.all([
        putObject(a.name, "x.txt", two),
        putObject(b.name, "y.txt", one),
      ]);
      expect(x.status).toBe(HTTP_STATUS.OK);
      expect(y.status).toBe(HTTP_STATUS.OK);
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

    it("PATCH createNewVersion edits in place once versioning was turned off while it waited", async () => {
      const { bucket, objectId } = await versionedObject();
      const before = await prisma.objectVersion.count({
        where: { objectId, deletedAt: null },
      });

      const patch = await queuedBehind(turnVersioningOff(bucket.id), () =>
        axios.patch(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}`,
          { tags: ["in-place"], createNewVersion: true },
          auth()
        )
      );

      expect(patch.status).toBe(HTTP_STATUS.OK);
      expect(
        await prisma.objectVersion.count({
          where: { objectId, deletedAt: null },
        })
      ).toBe(before);
      const current = await prisma.objectVersion.findFirstOrThrow({
        where: { objectId, isCurrent: true },
      });
      expect(current.tags).toEqual(["in-place"]);
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
          upload = putObject(bucket.name, "copy.txt", firstBody);
          await sleep(1000);
          released = release();
          await sleep(1000);
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

    it("a history purge and an upload of its content both complete", async () => {
      const { bucket, firstBody } = await versionedObject();

      const [upload, purge] = await raceUploadOfReleasedContent(
        bucket,
        firstBody,
        () =>
          axios.post(
            `${BASE_URL}/buckets/${bucket.name}/objects/purge-non-current-versions`,
            {},
            auth()
          )
      );

      expect(upload.status).toBe(HTTP_STATUS.CREATED);
      expect(purge.status).toBe(HTTP_STATUS.OK);
    });
  });
});
