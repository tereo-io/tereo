// @module-tag int
// @module-tag files
import { multipartCompleteClaim } from "../../../../../../../../../../routes/v1/files/buckets/bucket/multipart/utils.js";
import { MAX_BLOB_BYTES } from "../../../../../../../../../../utils/encryption.js";
import { multipartClient } from "../../../../../../../../../support/multipart.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../../../../../utils/db/prisma.js";
import env from "../../../../../../../../../../env.js";
import { randomBytes, randomUUID } from "crypto";
import { PassThrough, Readable } from "stream";
import fs from "fs/promises";
import axios from "axios";
import path from "path";
import {
  getRedisClient,
  redisKey,
} from "../../../../../../../../../../utils/redis.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  getTestAccessToken,
  getTestUserId,
  testIdempotencyKey,
  waitFor,
} from "../../../../../../../../../support/files.js";

describe("PUT /v1/files/buckets/:name/multipart/:uploadId/parts/:partNumber", () => {
  describe("multipart staging limits", () => {
    let token: string;

    const as = () => ({
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });

    const initiate = (
      bucketName: string,
      extra: Record<string, unknown> = {}
    ) =>
      axios.post(
        `${BASE_URL}/buckets/${bucketName}/multipart`,
        {
          objectKey: `big-${randomBytes(4).toString("hex")}.bin`,
          contentType: "application/octet-stream",
          ...extra,
        },
        as()
      );

    const putPart = (
      bucketName: string,
      uploadId: string,
      partNumber: number,
      body: Buffer | Readable
    ) =>
      axios.put(
        `${BASE_URL}/buckets/${bucketName}/multipart/${uploadId}/parts/${partNumber}`,
        body,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/octet-stream",
          },
          validateStatus: () => true,
        }
      );

    const stagedFiles = async (uploadId: string) =>
      (
        await fs
          .readdir(
            path.join(env.FILE_SERVICE_STORAGE_PATH, "multipart", uploadId)
          )
          .catch(() => [] as string[])
      ).length;

    // A part row standing for bytes never sent, to reach the size limits.
    const fakePart = (
      uploadId: string,
      partNumber: number,
      sizeBytes: bigint
    ) =>
      prisma.multipartPart.create({
        data: {
          uploadId,
          partNumber,
          sizeBytes,
          etag: randomBytes(16).toString("hex"),
          fsPath: `/nonexistent/${uploadId}/${partNumber}`,
        },
      });

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    // The fake parts below would otherwise count against the user's staged
    // bytes in every later test.
    afterEach(async () => {
      await prisma.multipartUpload.updateMany({
        where: {
          createdBy: getTestUserId(),
          completedAt: null,
          abortedAt: null,
        },
        data: { abortedAt: new Date() },
      });
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    it("refuses a part that takes the upload past its expectedSize", async () => {
      const bucket = await createTestBucket(token);
      const init = await initiate(bucket.name, { expectedSize: 10 });
      expect(init.status).toBe(HTTP_STATUS.CREATED);
      const { uploadId } = init.data;

      const first = await putPart(bucket.name, uploadId, 1, Buffer.alloc(6));
      expect(first.status).toBe(HTTP_STATUS.OK);

      const declared = await putPart(bucket.name, uploadId, 2, Buffer.alloc(6));
      expect(declared.status).toBe(HTTP_STATUS.PAYLOAD_TOO_LARGE);
      expect(declared.data.error).toBe("exceeds_expected_size");

      // Without a Content-Length, refused once staged, and its file removed.
      const chunked = await putPart(
        bucket.name,
        uploadId,
        2,
        Readable.from([Buffer.alloc(6)])
      );
      expect(chunked.status).toBe(HTTP_STATUS.PAYLOAD_TOO_LARGE);
      expect(chunked.data.error).toBe("exceeds_expected_size");
      expect(await prisma.multipartPart.count({ where: { uploadId } })).toBe(1);
      expect(await stagedFiles(uploadId)).toBe(1);

      // A part sent again replaces itself rather than adding to the total.
      const again = await putPart(bucket.name, uploadId, 1, Buffer.alloc(10));
      expect(again.status).toBe(HTTP_STATUS.OK);
    });

    it("refuses a part that takes the upload past the bucket's quota", async () => {
      const bucket = await createTestBucket(token, { storageQuotaBytes: "10" });
      const tooBig = await initiate(bucket.name, { expectedSize: 11 });
      expect(tooBig.status).toBe(HTTP_STATUS.INSUFFICIENT_STORAGE);
      expect(tooBig.data.error).toBe("insufficient_storage");

      // An upload from before the bucket had a quota reserved nothing, so
      // its parts are checked against the quota as they arrive.
      const unbounded = await createTestBucket(token);
      const { uploadId } = (await initiate(unbounded.name)).data;
      await prisma.bucket.update({
        where: { id: unbounded.id },
        data: { storageQuotaBytes: 10n },
      });
      expect(
        (await putPart(unbounded.name, uploadId, 1, Buffer.alloc(8))).status
      ).toBe(HTTP_STATUS.OK);
      const over = await putPart(unbounded.name, uploadId, 2, Buffer.alloc(8));
      expect(over.status).toBe(HTTP_STATUS.INSUFFICIENT_STORAGE);
      expect(over.data.error).toBe("insufficient_storage");
      expect(await prisma.multipartPart.count({ where: { uploadId } })).toBe(1);
    });

    it("requires expectedSize to initiate in a bucket with a quota", async () => {
      const bucket = await createTestBucket(token, {
        storageQuotaBytes: "1000",
      });
      const refused = await initiate(bucket.name);
      expect(refused.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(refused.data.error).toBe("expected_size_required");
      expect(
        await prisma.multipartUpload.count({ where: { bucketId: bucket.id } })
      ).toBe(0);

      expect((await initiate(bucket.name, { expectedSize: 10 })).status).toBe(
        HTTP_STATUS.CREATED
      );
    });

    it("caps the bytes one user has staged across uploads no quota bounds", async () => {
      const cap = BigInt(env.FILE_SERVICE_MAX_STAGED_MULTIPART_BYTES_PER_USER);
      const first = await createTestBucket(token);
      const held = (await initiate(first.name)).data.uploadId;
      await fakePart(held, 1, cap - 4n);

      // Bytes a quota reservation covers are not counted.
      const quota = await createTestBucket(token, {
        storageQuotaBytes: (2n * cap).toString(),
      });
      const reserved = await initiate(quota.name, {
        expectedSize: (cap / 2n).toString(),
      });
      expect(reserved.status).toBe(HTTP_STATUS.CREATED);
      await fakePart(reserved.data.uploadId, 1, cap / 2n);

      const second = await createTestBucket(token);
      const { uploadId } = (await initiate(second.name)).data;
      const declared = await putPart(second.name, uploadId, 1, Buffer.alloc(8));
      expect(declared.status).toBe(HTTP_STATUS.CONFLICT);
      expect(declared.data.error).toBe("multipart_staged_bytes_exceeded");

      // Without a Content-Length, refused once staged, and its file removed.
      const chunked = await putPart(
        second.name,
        uploadId,
        1,
        Readable.from([Buffer.alloc(8)])
      );
      expect(chunked.status).toBe(HTTP_STATUS.CONFLICT);
      expect(chunked.data.error).toBe("multipart_staged_bytes_exceeded");
      expect(await prisma.multipartPart.count({ where: { uploadId } })).toBe(0);
      expect(await stagedFiles(uploadId)).toBe(0);

      expect(
        (await putPart(second.name, uploadId, 1, Buffer.alloc(4))).status
      ).toBe(HTTP_STATUS.OK);
      // A part sent again replaces itself rather than adding to the total.
      expect(
        (await putPart(second.name, uploadId, 1, Buffer.alloc(4))).status
      ).toBe(HTTP_STATUS.OK);
      expect(
        (await putPart(second.name, uploadId, 2, Buffer.alloc(1))).status
      ).toBe(HTTP_STATUS.CONFLICT);

      // An aborted upload no longer holds its share.
      const aborted = await axios.delete(
        `${BASE_URL}/buckets/${first.name}/multipart/${held}`,
        as()
      );
      expect(aborted.status).toBeLessThan(300);
      expect(
        (await putPart(second.name, uploadId, 2, Buffer.alloc(8))).status
      ).toBe(HTTP_STATUS.OK);
    });

    it("refuses an upload whose expectedSize, with the others staged, passes the quota", async () => {
      const bucket = await createTestBucket(token, { storageQuotaBytes: "10" });
      const first = await initiate(bucket.name, { expectedSize: 6 });
      expect(first.status).toBe(HTTP_STATUS.CREATED);

      const over = await initiate(bucket.name, { expectedSize: 5 });
      expect(over.status).toBe(HTTP_STATUS.INSUFFICIENT_STORAGE);
      expect(over.data.error).toBe("insufficient_storage");

      const fits = await initiate(bucket.name, { expectedSize: 4 });
      expect(fits.status).toBe(HTTP_STATUS.CREATED);

      // The staged sizes now fill the quota.
      const full = await initiate(bucket.name, { expectedSize: 1 });
      expect(full.status).toBe(HTTP_STATUS.INSUFFICIENT_STORAGE);

      // An aborted upload no longer holds its share.
      const aborted = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/multipart/${first.data.uploadId}`,
        as()
      );
      expect(aborted.status).toBeLessThan(300);
      expect((await initiate(bucket.name, { expectedSize: 5 })).status).toBe(
        HTTP_STATUS.CREATED
      );
    });

    it("refuses an object larger than one blob can hold", async () => {
      const bucket = await createTestBucket(token);
      const declared = await initiate(bucket.name, {
        expectedSize: (MAX_BLOB_BYTES + 1n).toString(),
      });
      expect(declared.status).toBe(HTTP_STATUS.PAYLOAD_TOO_LARGE);
      expect(declared.data.error).toBe("object_too_large");

      const { uploadId } = (await initiate(bucket.name)).data;
      await fakePart(uploadId, 1, MAX_BLOB_BYTES - 2n);
      const part = await putPart(bucket.name, uploadId, 2, Buffer.alloc(5));
      expect(part.status).toBe(HTTP_STATUS.PAYLOAD_TOO_LARGE);
      expect(part.data.error).toBe("object_too_large");

      // Parts staged before the limit, refused at complete before any is read.
      const half = MAX_BLOB_BYTES / 2n + 1n;
      const staged = (await initiate(bucket.name)).data.uploadId;
      const parts = [
        await fakePart(staged, 1, half),
        await fakePart(staged, 2, half),
      ];
      const complete = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/multipart/${staged}/complete`,
        {
          parts: parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Idempotency-Key": testIdempotencyKey(),
          },
          validateStatus: () => true,
        }
      );
      expect(complete.status).toBe(HTTP_STATUS.PAYLOAD_TOO_LARGE);
      expect(complete.data.error).toBe("object_too_large");
    });

    it("caps the uploads one user has in progress in a bucket", async () => {
      const bucket = await createTestBucket(token);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await prisma.multipartUpload.createMany({
        data: Array.from(
          { length: env.FILE_SERVICE_MAX_ACTIVE_MULTIPART_UPLOADS },
          (_, i) => ({
            id: randomUUID(),
            bucketId: bucket.id,
            objectKey: `held-${i}.bin`,
            contentType: "application/octet-stream",
            createdBy: getTestUserId(),
            expiresAt,
            wrappedStagingDek: new Uint8Array(randomBytes(60)),
            stagingDekMasterKeyVersion: 1,
          })
        ),
      });

      const refused = await initiate(bucket.name);
      expect(refused.status).toBe(HTTP_STATUS.CONFLICT);
      expect(refused.data.error).toBe("too_many_multipart_uploads");

      // Another bucket is counted on its own.
      const other = await createTestBucket(token);
      expect((await initiate(other.name)).status).toBe(HTTP_STATUS.CREATED);

      // An expired upload no longer counts.
      const held = await prisma.multipartUpload.findFirstOrThrow({
        where: { bucketId: bucket.id },
      });
      await prisma.multipartUpload.update({
        where: { id: held.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect((await initiate(bucket.name)).status).toBe(HTTP_STATUS.CREATED);
    });
  });

  describe(
    "a part while its upload ends or completes",
    { tags: ["race"] },
    () => {
      let token: string;
      let bucketName: string;

      const { text, as, initiate, putPart, complete } = multipartClient(() => ({
        token,
        bucketName,
      }));

      const uploadDir = (uploadId: string) =>
        path.join(env.FILE_SERVICE_STORAGE_PATH, "multipart", uploadId);

      const stagedFiles = (uploadId: string) =>
        fs.readdir(uploadDir(uploadId)).catch(() => [] as string[]);

      // A part PUT whose body is held open until `finish`, once the server is
      // staging it.
      const heldPart = async (uploadId: string, partNumber: number) => {
        const before = (await stagedFiles(uploadId)).length;
        const body = new PassThrough();
        const response = putPart(uploadId, partNumber, body);
        body.write(randomBytes(1024));
        await waitFor(
          async () => (await stagedFiles(uploadId)).length > before,
          10_000
        );
        return {
          finish: async () => {
            body.end(randomBytes(1024));
            return await response;
          },
        };
      };

      beforeAll(async () => {
        token = await getTestAccessToken();
        bucketName = (await createTestBucket(token)).name;
      });

      afterAll(async () => {
        await cleanupTestEntities();
      });

      it("refuses a part whose upload was aborted while it was staged", async () => {
        const uploadId = await initiate();
        const held = await heldPart(uploadId, 1);

        const abort = await axios.delete(
          `${BASE_URL}/buckets/${bucketName}/multipart/${uploadId}`,
          as()
        );
        expect(abort.status).toBe(HTTP_STATUS.NO_CONTENT);

        const res = await held.finish();
        expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(res.data.error).toBe("upload_not_active");
        expect(await prisma.multipartPart.count({ where: { uploadId } })).toBe(
          0
        );
        await expect(fs.access(uploadDir(uploadId))).rejects.toThrow();
      });

      it("refuses a part whose upload was completed while it was staged", async () => {
        const uploadId = await initiate();
        const first = await putPart(uploadId, 1, text());
        const held = await heldPart(uploadId, 2);

        const done = await complete(uploadId, [
          { partNumber: 1, etag: first.data.etag },
        ]);
        expect(done.status).toBe(HTTP_STATUS.CREATED);

        const res = await held.finish();
        expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(res.data.error).toBe("upload_not_active");
        expect(await prisma.multipartPart.count({ where: { uploadId } })).toBe(
          0
        );
      });

      it("refuses a part while a complete of the upload runs", async () => {
        const uploadId = await initiate();
        const first = await putPart(uploadId, 1, text());
        const claim = redisKey(multipartCompleteClaim(uploadId));
        await getRedisClient().set(claim, "held-by-test", "EX", 60);
        try {
          const res = await putPart(uploadId, 1, text());
          expect(res.status).toBe(HTTP_STATUS.CONFLICT);
          expect(res.data.error).toBe("multipart_complete_in_progress");
          const [part] = await prisma.multipartPart.findMany({
            where: { uploadId },
          });
          expect(part.etag).toBe(first.data.etag);
          expect(await stagedFiles(uploadId)).toHaveLength(1);
        } finally {
          await getRedisClient().del(claim);
        }
      });

      it("answers the same 404 for an unknown upload and one of another bucket", async () => {
        const other = await createTestBucket(token);
        const elsewhere = await axios.post(
          `${BASE_URL}/buckets/${other.name}/multipart`,
          { objectKey: "o.bin", contentType: "application/octet-stream" },
          as()
        );
        expect(elsewhere.status).toBe(HTTP_STATUS.CREATED);

        const unknown = await putPart(randomUUID(), 1, text());
        const foreign = await putPart(elsewhere.data.uploadId, 1, text());
        expect(unknown.status).toBe(HTTP_STATUS.NOT_FOUND);
        expect(foreign.status).toBe(HTTP_STATUS.NOT_FOUND);
        const { request_id: _a, ...unknownBody } = unknown.data;
        const { request_id: _b, ...foreignBody } = foreign.data;
        expect(foreignBody).toEqual(unknownBody);
      });

      it("treats an upload id in upper case as the same upload", async () => {
        const uploadId = await initiate();
        const upper = uploadId.toUpperCase();
        expect(upper).not.toBe(uploadId);
        const stagingDirs = () =>
          fs.readdir(path.join(env.FILE_SERVICE_STORAGE_PATH, "multipart"));

        const first = await putPart(upper, 1, text());
        expect(first.status).toBe(HTTP_STATUS.OK);
        expect(await stagingDirs()).toContain(uploadId);
        expect(await stagingDirs()).not.toContain(upper);

        const claim = redisKey(multipartCompleteClaim(uploadId));
        await getRedisClient().set(claim, "held-by-test", "EX", 60);
        try {
          const res = await putPart(upper, 1, text());
          expect(res.status).toBe(HTTP_STATUS.CONFLICT);
          expect(res.data.error).toBe("multipart_complete_in_progress");
        } finally {
          await getRedisClient().del(claim);
        }

        const second = await putPart(upper, 2, text());
        expect(second.status).toBe(HTTP_STATUS.OK);
        const abort = await axios.delete(
          `${BASE_URL}/buckets/${bucketName}/multipart/${upper}`,
          as()
        );
        expect(abort.status).toBe(HTTP_STATUS.NO_CONTENT);
        const left = await stagingDirs();
        expect(left).not.toContain(uploadId);
        expect(left).not.toContain(upper);
      });
    }
  );

  describe("streamed uploads with a parseable Content-Type", () => {
    // A body whose Content-Type a JSON or form parser would match must still be
    // stored byte for byte by the streamed upload routes.
    const BODIES = [
      { contentType: "application/json", body: '{"hello":"world"}' },
      { contentType: "application/x-www-form-urlencoded", body: "a=1&b=2" },
    ];
    let token: string;
    const auth = () => ({ Authorization: `Bearer ${token}` });

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    const download = async (bucket: string, key: string) => {
      const res = await axios.get<ArrayBuffer>(
        `${BASE_URL}/buckets/${bucket}/objects/${key}`,
        { headers: auth(), responseType: "arraybuffer" }
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      return Buffer.from(res.data).toString();
    };

    it.each(BODIES)(
      "stores a multipart part's bytes ($contentType)",
      async ({ contentType, body }) => {
        const bucket = await createTestBucket(token);
        const init = await axios.post(
          `${BASE_URL}/buckets/${bucket.name}/multipart`,
          { objectKey: "parts.bin", contentType: "application/octet-stream" },
          { headers: auth() }
        );
        expect(init.status).toBe(HTTP_STATUS.CREATED);
        const uploadId = init.data.uploadId as string;

        const part = await axios.put(
          `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}/parts/1`,
          body,
          {
            headers: { ...auth(), "Content-Type": contentType },
            transformRequest: (data) => data,
          }
        );
        expect(part.status).toBe(HTTP_STATUS.OK);
        expect(part.data.sizeBytes).toBe(String(Buffer.byteLength(body)));

        const complete = await axios.post(
          `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}/complete`,
          { parts: [{ partNumber: 1, etag: part.data.etag }] },
          { headers: { ...auth(), "Idempotency-Key": testIdempotencyKey() } }
        );
        expect([HTTP_STATUS.OK, HTTP_STATUS.CREATED]).toContain(
          complete.status
        );
        expect(await download(bucket.name, "parts.bin")).toBe(body);
      }
    );

    it("streams a part and parses a large complete when the path ends in a slash", async () => {
      const body = '{"hello":"world"}';
      const bucket = await createTestBucket(token);
      const init = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/multipart`,
        { objectKey: "slash.bin", contentType: "application/octet-stream" },
        { headers: auth() }
      );
      const upload = `${BASE_URL}/buckets/${bucket.name}/multipart/${init.data.uploadId}`;

      const part = await axios.put(`${upload}/parts/1/`, body, {
        headers: { ...auth(), "Content-Type": "application/json" },
        transformRequest: (data) => data,
        validateStatus: () => true,
      });
      expect(part.status).toBe(HTTP_STATUS.OK);
      expect(part.data.sizeBytes).toBe(String(Buffer.byteLength(body)));

      // Past the 1mb of the area's JSON parser, within the route's own 5mb.
      const parts = JSON.stringify({
        parts: [{ partNumber: 1, etag: part.data.etag }],
      });
      const complete = await axios.post(
        `${upload}/complete/`,
        parts + " ".repeat(1_200_000),
        {
          headers: {
            ...auth(),
            "Content-Type": "application/json",
            "Idempotency-Key": testIdempotencyKey(),
          },
          transformRequest: (data) => data,
          validateStatus: () => true,
        }
      );
      expect([HTTP_STATUS.OK, HTTP_STATUS.CREATED]).toContain(complete.status);
      expect(await download(bucket.name, "slash.bin")).toBe(body);
    });
  });
});
