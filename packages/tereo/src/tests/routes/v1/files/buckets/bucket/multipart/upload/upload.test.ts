// @module-tag int
// @module-tag files
// @module-tag race
import { multipartClient } from "../../../../../../../support/multipart.js";
import { getRedisClient } from "../../../../../../../../utils/redis.js";
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db from "../../../../../../../../utils/db/index.js";
import { randomBytes, randomUUID } from "crypto";
import env from "../../../../../../../../env.js";
import { execFileSync } from "child_process";
import { Readable } from "stream";
import fs from "fs/promises";
import axios from "axios";
import path from "path";
import {
  aadForPart,
  createMultipartPartDecryptStream,
  createMultipartPartEncryptStream,
} from "../../../../../../../../utils/encryption.js";
import {
  FIXTURE_USER_IDS,
  ensureTestMembership,
  getTestPrincipalToken,
} from "../../../../../../../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  getTestAccessToken,
  grantTestPermission,
  testIdempotencyKey,
} from "../../../../../../../support/files.js";

describe("POST, GET and DELETE /v1/files/buckets/:name/multipart/:uploadId", () => {
  describe("multipart write integrity", () => {
    const MIN_PART = env.FILE_SERVICE_MIN_PART_SIZE_MB * 1024 * 1024;

    let token: string;
    let bucketName: string;

    const { text, as, initiate, putPart, complete } = multipartClient(() => ({
      token,
      bucketName,
    }));

    // Re-encrypts a staged part as it was staged before parts were bound.
    const unbindPart = async (uploadId: string, partNumber: number) => {
      const upload = await db.multipartUploads.getAny(uploadId);
      const dek = db.multipartUploads.unwrapStagingDek(upload);
      const part = await prisma.multipartPart.findUniqueOrThrow({
        where: { uploadId_partNumber: { uploadId, partNumber } },
      });
      const chunks: Buffer[] = [];
      for await (const chunk of Readable.from([
        await fs.readFile(part.fsPath),
      ]).pipe(
        createMultipartPartDecryptStream(dek, aadForPart(uploadId, partNumber))
      )) {
        chunks.push(chunk as Buffer);
      }
      const legacy: Buffer[] = [];
      // An empty AAD is what GCM authenticates when none is set.
      for await (const chunk of Readable.from([Buffer.concat(chunks)]).pipe(
        createMultipartPartEncryptStream(dek, Buffer.alloc(0))
      )) {
        legacy.push(chunk as Buffer);
      }
      await fs.writeFile(part.fsPath, Buffer.concat(legacy));
      await prisma.multipartPart.update({
        where: { id: part.id },
        data: { aadBound: false },
      });
      return part;
    };

    const swapPartFiles = async (uploadId: string) => {
      const [one, two] = await prisma.multipartPart.findMany({
        where: { uploadId },
        orderBy: { partNumber: "asc" },
      });
      await prisma.multipartPart.update({
        where: { id: one.id },
        data: { fsPath: two.fsPath },
      });
      await prisma.multipartPart.update({
        where: { id: two.id },
        data: { fsPath: one.fsPath },
      });
    };

    const twoParts = async () => {
      const uploadId = await initiate();
      const first = await putPart(uploadId, 1, randomBytes(MIN_PART));
      const second = await putPart(uploadId, 2, randomBytes(MIN_PART));
      expect([first.status, second.status]).toEqual([200, 200]);
      return {
        uploadId,
        parts: [
          { partNumber: 1, etag: first.data.etag as string },
          { partNumber: 2, etag: second.data.etag as string },
        ],
      };
    };

    beforeAll(async () => {
      token = await getTestAccessToken();
      bucketName = (await createTestBucket(token)).name;
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    it("refuses to complete with a part file moved to another part", async () => {
      const { uploadId, parts } = await twoParts();
      await swapPartFiles(uploadId);
      const res = await complete(uploadId, parts);
      expect(res.status).toBe(422);
      expect(res.data.error).toBe("part_integrity_mismatch");
      expect(
        await prisma.multipartUpload.findUniqueOrThrow({
          where: { id: uploadId },
        })
      ).toMatchObject({ completedAt: null });
    });

    it("refuses to complete with unbound parts whose contents were swapped", async () => {
      const { uploadId, parts } = await twoParts();
      await unbindPart(uploadId, 1);
      await unbindPart(uploadId, 2);
      await swapPartFiles(uploadId);
      const res = await complete(uploadId, parts);
      expect(res.status).toBe(422);
      expect(res.data.error).toBe("part_integrity_mismatch");
    });

    it("completes an upload with a part staged before parts were bound", async () => {
      const uploadId = await initiate();
      const content = Buffer.from(`legacy ${randomBytes(8).toString("hex")}`);
      const put = await putPart(uploadId, 1, content);
      await unbindPart(uploadId, 1);

      const res = await complete(uploadId, [
        { partNumber: 1, etag: put.data.etag },
      ]);
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      const download = await axios.get(
        `${BASE_URL}/buckets/${bucketName}/objects/${res.data.key}`,
        { ...as(), responseType: "arraybuffer" }
      );
      expect(Buffer.from(download.data).equals(content)).toBe(true);
    });

    it("lists an upload's parts only for the user who initiated it", async () => {
      const uploadId = await initiate();
      await putPart(uploadId, 1, text());
      const otherId = FIXTURE_USER_IDS[2];
      await grantTestPermission(token, bucketName, otherId, { canRead: true });
      const other = await getTestPrincipalToken({
        userId: otherId,
        permissions: ["file-service.objects.read"],
      });

      const url = `${BASE_URL}/buckets/${bucketName}/multipart/${uploadId}`;
      const refused = await axios.get(url, as(other));
      expect(refused.status).toBe(HTTP_STATUS.FORBIDDEN);
      const own = await axios.get(url, as());
      expect(own.status).toBe(HTTP_STATUS.OK);
      expect(own.data.parts).toHaveLength(1);
    });
  });

  describe("File Service Overhaul — end-to-end flows", () => {
    const authHeader = (token: string) => ({
      Authorization: `Bearer ${token}`,
    });
    let testToken: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("multipart expectedSize", () => {
      const completeWith = async (expectedSize: number, body: string) => {
        const bucket = await createTestBucket(testToken, { policy: "private" });
        const init = await axios.post(
          `${BASE_URL}/buckets/${bucket.name}/multipart`,
          {
            objectKey: "sized.bin",
            contentType: "application/octet-stream",
            expectedSize,
          },
          { headers: authHeader(testToken) }
        );
        expect(init.status).toBe(HTTP_STATUS.CREATED);
        const uploadId = init.data.uploadId as string;
        const part = await axios.put(
          `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}/parts/1`,
          Buffer.from(body),
          {
            headers: {
              ...authHeader(testToken),
              "Content-Type": "application/octet-stream",
            },
          }
        );
        expect(part.status).toBe(HTTP_STATUS.OK);
        return await axios.post(
          `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}/complete`,
          { parts: [{ partNumber: 1, etag: part.data.etag }] },
          {
            headers: {
              ...authHeader(testToken),
              "Idempotency-Key": testIdempotencyKey(),
            },
            validateStatus: () => true,
          }
        );
      };

      it("refuses parts totalling another size", async () => {
        const res = await completeWith(6, "12345");
        expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(res.data.error).toBe("size_mismatch");
      });

      it("completes parts totalling exactly that size", async () => {
        const res = await completeWith(5, "12345");
        expect([HTTP_STATUS.OK, HTTP_STATUS.CREATED]).toContain(res.status);
        expect(res.data.sizeBytes).toBe("5");
      });
    });
  });

  describe("concurrent writes", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

      it(
        "runs once however long assembly takes, and a retry gets its result",
        { tags: ["slow"] },
        async () => {
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
          const duringSameKey = await complete(
            bucket.name,
            uploadId,
            parts,
            first
          );

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
          expect(duringOtherKey.data.error).toBe(
            "multipart_complete_in_progress"
          );
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
        }
      );
    });
  });

  describe("Bucket access", () => {
    // Everything a bucket creator does here, but no `file-service.admin`: object
    // access has to come from the creator's grant.
    const MEMBER = [
      "file-service.buckets.delete",
      "file-service.objects.delete",
      "file-service.permissions.delete",
      "file-service.shares.delete",
    ];

    const ORG = "bucket-access-org";

    const as = (token?: string) => ({
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      validateStatus: () => true,
    });

    const member = (organizationId: string | null = ORG) =>
      getTestPrincipalToken({
        userId: randomUUID(),
        organizationId,
        permissions: MEMBER,
      });

    // A grant in an organization's bucket goes to a member of it.
    const grantInOrg = async (
      token: string,
      bucketName: string,
      userId: string,
      flags: { canRead?: boolean; canWrite?: boolean; canDelete?: boolean }
    ) => {
      await ensureTestMembership(userId, ORG);
      return await grantTestPermission(token, bucketName, userId, flags);
    };
    let creatorId: string;
    let creatorToken: string;
    let outsiderToken: string;

    beforeAll(async () => {
      creatorId = randomUUID();
      creatorToken = await getTestPrincipalToken({
        userId: creatorId,
        organizationId: ORG,
        permissions: MEMBER,
      });
      outsiderToken = await member();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("multipart abort", () => {
      const initiate = async (token: string, bucketName: string) => {
        const res = await axios.post(
          `${BASE_URL}/buckets/${bucketName}/multipart`,
          { objectKey: "big.bin", contentType: "application/octet-stream" },
          as(token)
        );
        expect(res.status).toBe(HTTP_STATUS.CREATED);
        return res.data.uploadId as string;
      };

      it("needs the delete grant, not the write grant", async () => {
        const bucket = await createTestBucket(creatorToken);
        const userId = randomUUID();
        const token = await getTestPrincipalToken({
          userId,
          organizationId: ORG,
          permissions: MEMBER,
        });
        await grantInOrg(creatorToken, bucket.name, userId, {
          canRead: true,
          canWrite: true,
        });
        const uploadId = await initiate(token, bucket.name);

        const res = await axios.delete(
          `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}`,
          as(token)
        );
        expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      });

      it("checks access before looking up the upload", async () => {
        const bucket = await createTestBucket(creatorToken);
        const other = await createTestBucket(creatorToken);
        const uploadId = await initiate(creatorToken, bucket.name);
        const etag = "0".repeat(32);
        const calls = (name: string, id: string) => {
          const base = `${BASE_URL}/buckets/${name}/multipart/${id}`;
          return {
            list: (token: string) => axios.get(base, as(token)),
            part: (token: string) =>
              axios.put(`${base}/parts/1`, "x", {
                ...as(token),
                headers: {
                  ...as(token).headers,
                  "Content-Type": "application/octet-stream",
                },
              }),
            complete: (token: string) =>
              axios.post(
                `${base}/complete`,
                { parts: [{ partNumber: 1, etag }] },
                {
                  ...as(token),
                  headers: {
                    ...as(token).headers,
                    "Idempotency-Key": randomUUID(),
                  },
                }
              ),
            abort: (token: string) => axios.delete(base, as(token)),
          };
        };

        for (const id of [uploadId, randomUUID()]) {
          for (const [op, call] of Object.entries(calls(bucket.name, id))) {
            const res = await call(outsiderToken);
            expect([op, id, res.status]).toEqual([
              op,
              id,
              HTTP_STATUS.FORBIDDEN,
            ]);
          }
        }

        for (const [op, call] of Object.entries(
          calls(bucket.name, randomUUID())
        )) {
          const res = await call(creatorToken);
          expect([op, res.status]).toEqual([op, HTTP_STATUS.NOT_FOUND]);
        }
        for (const [op, call] of Object.entries(calls(other.name, uploadId))) {
          const res = await call(creatorToken);
          expect([op, res.status]).toEqual([op, HTTP_STATUS.NOT_FOUND]);
        }
      });

      it("goes on in a retired bucket", async () => {
        const bucket = await createTestBucket(creatorToken);
        const uploadId = await initiate(creatorToken, bucket.name);
        await prisma.bucket.update({
          where: { id: bucket.id },
          data: { retiredAt: new Date() },
        });

        const res = await axios.delete(
          `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}`,
          as(creatorToken)
        );
        expect(res.status).toBe(HTTP_STATUS.NO_CONTENT);
      });
    });
  });
});
