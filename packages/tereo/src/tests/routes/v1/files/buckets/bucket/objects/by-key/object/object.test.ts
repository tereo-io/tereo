// @module-tag int
// @module-tag files
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("GET /v1/files/buckets/:name/objects/by-key/*objectKey", () => {
  interface ObjectResponse {
    id: string;
    key: string;
    contentType: string;
    sizeBytes: string;
    etag: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
    createdAt: string;
    updatedAt?: string;
  }

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
  let testToken: string;

  beforeAll(async () => {
    testToken = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("GET /objects/by-key/:objectKey", () => {
    it("resolves a key to the full object (including UUID id)", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      const uploaded = await uploadTestObject(
        testToken,
        bucket.name,
        "deep/path/file.txt",
        createTestFile("hi", "file.txt", "text/plain")
      );

      const res = await axios.get<ObjectResponse>(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-key/deep/path/file.txt`,
        { headers: authHeader(testToken) }
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.data.id).toBe(uploaded.id);
      expect(res.data.key).toBe("deep/path/file.txt");
    });

    it("returns 404 for a missing key", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      const res = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-key/missing.txt`,
        { headers: authHeader(testToken), validateStatus: () => true }
      );
      expect(res.status).toBe(HTTP_STATUS.NOT_FOUND);
    });
  });
});
