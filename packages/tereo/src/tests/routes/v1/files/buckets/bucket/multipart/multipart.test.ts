// @module-tag int
// @module-tag files
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  getTestAccessToken,
  uploadTestObject,
} from "../../../../../../support/files.js";

describe("POST /v1/files/buckets/:name/multipart", () => {
  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
  let testToken: string;

  beforeAll(async () => {
    testToken = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("Metadata limits outside the upload header", () => {
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`key${i}`, "value"])
    );
    const tooLarge = { blob: Array(20).fill("x".repeat(10_000)) };

    it("rejects oversized metadata on multipart initiate", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      for (const metadata of [tooManyKeys, tooLarge]) {
        const res = await axios.post(
          `${BASE_URL}/buckets/${bucket.name}/multipart`,
          {
            objectKey: "meta-limits.bin",
            contentType: "application/octet-stream",
            metadata,
          },
          { headers: authHeader(testToken), validateStatus: () => true }
        );
        expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(res.data.error).toBe("invalid_request");
        expect(res.data.error_description).toEqual(expect.any(String));
      }
    });
  });
  describe("preconditions at initiate", () => {
    const key = "pre-initiate.bin";
    let bucket: Awaited<ReturnType<typeof createTestBucket>>;
    let etag: string;

    beforeAll(async () => {
      bucket = await createTestBucket(testToken, { policy: "private" });
      const created = await uploadTestObject(testToken, bucket.name, key, {
        buffer: Buffer.from("existing"),
        filename: key,
        contentType: "application/octet-stream",
      });
      etag = created.etag as string;
    });

    const initiate = (objectKey: string, headers: Record<string, string>) =>
      axios.post(
        `${BASE_URL}/buckets/${bucket.name}/multipart`,
        { objectKey, contentType: "application/octet-stream" },
        {
          headers: { ...authHeader(testToken), ...headers },
          validateStatus: () => true,
        }
      );

    const uploadCount = async () => {
      const row = await prisma.bucket.findFirstOrThrow({
        where: { name: bucket.name },
      });
      return prisma.multipartUpload.count({ where: { bucketId: row.id } });
    };

    it("initiate with If-None-Match: * on an existing key returns 412 and creates no upload", async () => {
      const before = await uploadCount();
      const res = await initiate(key, { "If-None-Match": "*" });
      expect(res.status).toBe(412);
      expect(res.data.error).toBe("precondition_failed");
      expect(await uploadCount()).toBe(before);
    });

    it("initiate with a stale If-Match returns 412", async () => {
      const res = await initiate(key, { "If-Match": '"not-the-etag"' });
      expect(res.status).toBe(412);
      expect(res.data.error).toBe("precondition_failed");
    });

    it("initiate with If-Match on a missing key returns 412", async () => {
      const res = await initiate("missing.bin", { "If-Match": '"abc"' });
      expect(res.status).toBe(412);
    });

    it("initiates when the preconditions hold", async () => {
      const matching = await initiate(key, { "If-Match": `"${etag}"` });
      expect(matching.status).toBe(HTTP_STATUS.CREATED);
      const createOnly = await initiate("fresh.bin", { "If-None-Match": "*" });
      expect(createOnly.status).toBe(HTTP_STATUS.CREATED);
    });
  });
});
