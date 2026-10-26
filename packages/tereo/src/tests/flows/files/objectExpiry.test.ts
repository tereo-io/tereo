// @module-tag int
// @module-tag files
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import db from "../../../utils/db/index.js";
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
} from "../../support/files.js";

describe("object expiry", () => {
  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
  let testToken: string;

  beforeAll(async () => {
    testToken = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("Expiry across overwrites", () => {
    const expiresAt = new Date(Date.now() + 7 * 86_400_000);

    // Uploads `key` and sets its expiry with PATCH; returns the object id.
    const expiringObject = async (bucketName: string, key: string) => {
      const uploaded = await uploadTestObject(
        testToken,
        bucketName,
        key,
        createTestFile("first", key, "text/plain")
      );
      const patch = await axios.patch(
        `${BASE_URL}/buckets/${bucketName}/objects/by-id/${uploaded.id}`,
        { deleteAfter: expiresAt.toISOString() },
        {
          headers: {
            ...authHeader(testToken),
            "Content-Type": "application/json",
          },
        }
      );
      expect(patch.status).toBe(HTTP_STATUS.OK);
      return uploaded.id;
    };

    const expectExpiryKept = async (id: string) => {
      const row = await prisma.object.findUniqueOrThrow({ where: { id } });
      expect(row.deleteAfter?.getTime()).toBe(expiresAt.getTime());
    };

    for (const versioningEnabled of [false, true]) {
      it(`keeps it through a simple upload (versioning ${versioningEnabled ? "on" : "off"})`, async () => {
        const bucket = await createTestBucket(testToken);
        if (versioningEnabled) {
          await axios.put(
            `${BASE_URL}/buckets/${bucket.name}`,
            { versioningEnabled: true },
            {
              headers: {
                ...authHeader(testToken),
                "Content-Type": "application/json",
              },
            }
          );
        }
        const id = await expiringObject(bucket.name, "keep.txt");

        const again = await uploadTestObject(
          testToken,
          bucket.name,
          "keep.txt",
          createTestFile("second", "keep.txt", "text/plain")
        );
        expect(again.id).toBe(id);
        await expectExpiryKept(id);

        const get = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${id}`,
          { headers: authHeader(testToken) }
        );
        expect(get.data.deleteAfter).toBe(expiresAt.toISOString());
      });
    }

    it("is cleared by PATCH deleteAfter: null, and the sweep leaves the object", async () => {
      const bucket = await createTestBucket(testToken);
      const id = await expiringObject(bucket.name, "clear.txt");

      const patch = await axios.patch(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${id}`,
        { deleteAfter: null },
        { headers: authHeader(testToken), validateStatus: () => true }
      );
      expect(patch.status).toBe(HTTP_STATUS.OK);
      const row = await prisma.object.findUniqueOrThrow({ where: { id } });
      expect(row.deleteAfter).toBeNull();

      // What the lifecycle sweep would soft-delete.
      const due = await db.lifecyclePolicies.findExpiredDeleteAfter(100_000);
      expect(due.map((o) => o.id)).not.toContain(id);
    });

    it("keeps it through a presigned write", async () => {
      const bucket = await createTestBucket(testToken);
      const id = await expiringObject(bucket.name, "presigned.txt");

      const presign = await axios.post<{ url: string }>(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${id}/presign`,
        { operation: "write", expiresInSeconds: 60 },
        { headers: authHeader(testToken) }
      );
      const put = await axios.put(presign.data.url, Buffer.from("second"), {
        headers: { "Content-Type": "text/plain" },
        validateStatus: () => true,
      });
      expect([HTTP_STATUS.OK, HTTP_STATUS.CREATED]).toContain(put.status);
      await expectExpiryKept(id);
    });

    it("keeps it through a completed multipart upload", async () => {
      const bucket = await createTestBucket(testToken);
      const id = await expiringObject(bucket.name, "big.bin");

      const init = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/multipart`,
        { objectKey: "big.bin", contentType: "application/octet-stream" },
        { headers: authHeader(testToken) }
      );
      expect(init.status).toBe(HTTP_STATUS.CREATED);
      const uploadId = init.data.uploadId as string;
      const part = await axios.put(
        `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}/parts/1`,
        Buffer.from("multipart body"),
        {
          headers: {
            ...authHeader(testToken),
            "Content-Type": "application/octet-stream",
          },
        }
      );
      expect(part.status).toBe(HTTP_STATUS.OK);
      const complete = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}/complete`,
        { parts: [{ partNumber: 1, etag: part.data.etag }] },
        {
          headers: {
            ...authHeader(testToken),
            "Idempotency-Key": testIdempotencyKey(),
          },
        }
      );
      expect([HTTP_STATUS.OK, HTTP_STATUS.CREATED]).toContain(complete.status);
      expect(complete.data.id).toBe(id);
      await expectExpiryKept(id);
    });

    it("is gone once the object is deleted and uploaded afresh", async () => {
      const bucket = await createTestBucket(testToken);
      const id = await expiringObject(bucket.name, "fresh.txt");
      const del = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${id}`,
        { headers: authHeader(testToken) }
      );
      expect(del.status).toBe(HTTP_STATUS.NO_CONTENT);

      const fresh = await uploadTestObject(
        testToken,
        bucket.name,
        "fresh.txt",
        createTestFile("new", "fresh.txt", "text/plain")
      );
      expect(fresh.id).not.toBe(id);
      const row = await prisma.object.findUniqueOrThrow({
        where: { id: fresh.id },
      });
      expect(row.deleteAfter).toBeNull();
    });
  });
});
