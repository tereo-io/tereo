// @module-tag int
// @module-tag files
// @module-tag race
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "crypto";
import FormData from "form-data";
import fs from "fs/promises";
import axios from "axios";
import {
  lockWaiters,
  untilQueued,
} from "../../../../../../../../tests/support/dbLocks.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  testIdempotencyKey,
  uploadTestObject,
} from "../../../../../../../support/files.js";

describe("PUT /v1/files/buckets/:name/objects/*objectKey", () => {
  describe("Conditional writes and download caching", () => {
    const put = (
      token: string,
      bucketName: string,
      key: string,
      content: string,
      headers: Record<string, string> = {},
      contentType = "text/plain"
    ) => {
      const form = new FormData();
      form.append("file", Buffer.from(content), {
        filename: "file.txt",
        contentType,
      });
      return axios.put(
        `${BASE_URL}/buckets/${bucketName}/objects/${key}`,
        form,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...form.getHeaders(),
            ...headers,
          },
          validateStatus: () => true,
        }
      );
    };
    let token: string;

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("If-None-Match: * on upload", () => {
      it("lets exactly one of several concurrent creates win", async () => {
        const bucket = await createTestBucket(token);
        const results = await Promise.all(
          ["one", "two", "three"]
            .map((n) => `${n} ${randomUUID()}`)
            .map((content) =>
              put(token, bucket.name, "race.txt", content, {
                "If-None-Match": "*",
              })
            )
        );
        const statuses = results.map((r) => r.status).sort();
        expect(statuses.filter((s) => s === HTTP_STATUS.CREATED)).toHaveLength(
          1
        );
        expect(statuses.filter((s) => s === 412)).toHaveLength(2);
      });
    });
  });

  describe("concurrent writes", () => {
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
          const baseline = await lockWaiters();
          pending = Promise.all(requests.map((r) => r()));
          await untilQueued(baseline, requests.length);
        },
        { timeout: 30_000 }
      );
      return pending;
    }

    const lockBuckets = (ids: number[]) => (tx: Tx) =>
      tx.$queryRaw`SELECT 1 FROM "files"."buckets" WHERE "id" = ANY(${ids}::int[]) ORDER BY "id" FOR UPDATE`;
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
            () =>
              uploadTestObject(token, a.name, "x.txt", createTestFile(body)),
            () =>
              uploadTestObject(token, b.name, "y.txt", createTestFile(body)),
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
          const form = new globalThis.FormData();
          form.append(
            "file",
            new Blob([body], { type: "text/plain" }),
            "k.txt"
          );
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
              uploadTestObject(
                token,
                ok.name,
                "keep.txt",
                createTestFile(body)
              ),
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
  });

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
  });

  describe("files integrity", () => {
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

    const versions = (objectId: string) =>
      prisma.objectVersion.findMany({
        where: { objectId, deletedAt: null },
        orderBy: { createdAt: "asc" },
      });

    it("an upload goes by the versioning setting at commit, not at arrival", async () => {
      const bucket = await createTestBucket(token);
      const obj = await upload(bucket.name, "v.txt", `v1 ${randomUUID()}`);

      let overwrite: Promise<unknown> | undefined;
      await whileLocked(
        (tx) =>
          tx.$executeRaw`UPDATE "files"."buckets" SET "versioning_enabled" = true WHERE "id" = ${bucket.id}`,
        async () => {
          const baseline = await lockWaiters();
          overwrite = upload(bucket.name, "v.txt", `v2 ${randomUUID()}`);
          await untilQueued(baseline, 1, 1500);
        }
      );
      await overwrite;

      expect(await versions(obj.id)).toHaveLength(2);
    });
  });
});
