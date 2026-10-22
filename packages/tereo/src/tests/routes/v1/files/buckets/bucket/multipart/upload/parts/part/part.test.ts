// @module-tag int
// @module-tag files
import { MAX_BLOB_BYTES } from "../../../../../../../../../../utils/encryption.js";
import { prisma } from "../../../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import env from "../../../../../../../../../../env.js";
import { randomBytes, randomUUID } from "crypto";
import { Readable } from "stream";
import fs from "fs/promises";
import axios from "axios";
import path from "path";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  getTestAccessToken,
  getTestUserId,
  testIdempotencyKey,
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

      const { uploadId } = (await initiate(bucket.name)).data;
      expect(
        (await putPart(bucket.name, uploadId, 1, Buffer.alloc(8))).status
      ).toBe(HTTP_STATUS.OK);
      const over = await putPart(bucket.name, uploadId, 2, Buffer.alloc(8));
      expect(over.status).toBe(HTTP_STATUS.INSUFFICIENT_STORAGE);
      expect(over.data.error).toBe("insufficient_storage");
      expect(await prisma.multipartPart.count({ where: { uploadId } })).toBe(1);
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
  });
});
