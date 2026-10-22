// @module-tag int
// @module-tag files
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  getTestAccessToken,
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
      }
    });
  });
});
