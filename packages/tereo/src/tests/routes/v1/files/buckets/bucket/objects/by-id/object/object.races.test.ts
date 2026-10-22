// @module-tag int
// @module-tag files
// @module-tag race
import { prisma } from "../../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObject,
} from "../../../../../../../../support/files.js";

describe("PATCH /v1/files/buckets/:name/objects/by-id/:id", () => {
  describe("object write lock order", () => {
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

    describe("versioning is read under the bucket lock", () => {
      const turnVersioningOff = (bucketId: number) => (tx: Tx) =>
        tx.$executeRaw`UPDATE "files"."buckets" SET "versioning_enabled" = false WHERE "id" = ${bucketId}`;

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
  });

  describe("files integrity", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    /**
     * Runs `during` while a transaction holds `lock` (a statement that takes a
     * row lock), then commits. Lets a test queue a request behind the lock and
     * so fix the order two writers reach a row.
     */
    async function whileLocked(
      lock: (tx: typeof prisma) => Promise<unknown>,
      during: () => Promise<void>
    ) {
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      const holder = prisma.$transaction(
        async (tx) => {
          await lock(tx as unknown as typeof prisma);
          locked();
          await released;
        },
        { timeout: 30_000 }
      );
      await isLocked;
      try {
        await during();
      } finally {
        release();
        await holder;
      }
    }
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

    const upload = (bucketName: string, key: string, body: string) =>
      uploadTestObject(
        token,
        bucketName,
        key,
        createTestFile(body, key.split("/").pop(), "text/plain")
      );

    it("PATCH edits the version that is current when it runs", async () => {
      const bucket = await createTestBucket(token);
      const obj = await upload(bucket.name, "p.txt", `p1 ${randomUUID()}`);

      // The overwrite queues on the object's lock first, the PATCH after it.
      let overwrite: Promise<unknown> | undefined;
      let patching: Promise<{ status: number }> | undefined;
      await whileLocked(
        (tx) =>
          tx.$queryRaw`SELECT 1 FROM "files"."objects" WHERE "id" = ${obj.id}::uuid FOR UPDATE`,
        async () => {
          overwrite = upload(bucket.name, "p.txt", `p2 ${randomUUID()}`);
          await sleep(1000);
          patching = axios.patch(
            `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}`,
            { tags: ["patched"] },
            auth()
          );
          await sleep(1000);
        }
      );
      await overwrite;
      const patch = await patching!;

      expect(patch.status).toBe(HTTP_STATUS.OK);
      const current = await prisma.objectVersion.findFirstOrThrow({
        where: { objectId: obj.id, isCurrent: true, deletedAt: null },
      });
      expect(current.tags).toEqual(["patched"]);
    });
  });
});
