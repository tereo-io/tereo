import { describe, it, expect, beforeAll, afterAll } from "vitest";
import FormData from "form-data";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  createTestBucket,
  createTestFile,
  uploadTestObject,
  cleanupTestEntities,
  createFormDataWithMetadata,
  testIdempotencyKey,
} from "./utils/test-helpers.js";

interface ObjectResponse {
  id: string;
  key: string;
  contentType: string;
  sizeBytes: string;
  etag: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
}

interface ObjectsListResponse {
  data: ObjectResponse[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}

describe("Object Management", () => {
  let testToken: string;
  let testBucket: { id: number; name: string; policy: string };

  beforeAll(async () => {
    testToken = await getTestAccessToken();
    testBucket = await createTestBucket(testToken, { policy: "private" });
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("PUT /buckets/:name/objects/*", () => {
    it("should upload a new object", async () => {
      const file = createTestFile("Hello, World!", "test.txt", "text/plain");
      const objectKey = "test-file.txt";

      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      const response = await axios.put<ObjectResponse>(
        `${BASE_URL}/buckets/${testBucket.name}/objects/${objectKey}`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
          },
          validateStatus: () => true,
        }
      );

      const data = response.data;

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(data.id).toBeDefined();
      expect(data.key).toBe(objectKey);
      expect(data.contentType).toBe("text/plain");
      expect(data.etag).toBeDefined();
      expect(data.createdAt).toBeDefined();
      expect(parseInt(data.sizeBytes)).toBeGreaterThan(0);
    });

    it("should upload object with metadata", async () => {
      const file = createTestFile("Test content", "meta.txt", "text/plain");
      const objectKey = "test-with-metadata.txt";
      const metadata = { author: "test-user", version: "1.0" };

      const { formData, headers: metadataHeaders } = createFormDataWithMetadata(
        file,
        metadata
      );

      const response = await axios.put<ObjectResponse>(
        `${BASE_URL}/buckets/${testBucket.name}/objects/${objectKey}`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
            ...metadataHeaders,
          },
          validateStatus: () => true,
        }
      );

      const data = response.data;

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(data.metadata).toBeDefined();
      expect(data.metadata?.author).toBe(metadata.author);
      expect(data.metadata?.version).toBe(metadata.version);
    });

    it("should update existing object", async () => {
      const file1 = createTestFile("Version 1", "test.txt", "text/plain");
      const objectKey = "update-test.txt";

      // Upload first version
      await uploadTestObject(testToken, testBucket.name, objectKey, file1);

      // Upload updated version
      const file2 = createTestFile(
        "Version 2 - Updated",
        "test.txt",
        "text/plain"
      );
      const formData = new FormData();
      formData.append("file", file2.buffer, {
        filename: file2.filename,
        contentType: file2.contentType,
      });

      const response = await axios.put<ObjectResponse>(
        `${BASE_URL}/buckets/${testBucket.name}/objects/${objectKey}`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
          },
          validateStatus: () => true,
        }
      );

      const data = response.data;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.key).toBe(objectKey);
      expect(data.updatedAt).toBeDefined();
      expect(parseInt(data.sizeBytes)).toBe(file2.buffer.length);
    });

    it("should return 401 without authentication", async () => {
      const file = createTestFile("Test", "test.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      const response = await axios.put(
        `${BASE_URL}/buckets/${testBucket.name}/objects/unauthorized.txt`,
        formData,
        {
          headers: formData.getHeaders(),
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it("should return 400 when no file is provided", async () => {
      const formData = new FormData();

      const response = await axios.put(
        `${BASE_URL}/buckets/${testBucket.name}/objects/no-file.txt`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should return 413 for too many or oversized text fields", async () => {
      const send = async (formData: FormData) =>
        axios.put(
          `${BASE_URL}/buckets/${testBucket.name}/objects/fields.txt`,
          formData,
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Idempotency-Key": testIdempotencyKey(),
              ...formData.getHeaders(),
            },
            validateStatus: () => true,
          }
        );

      const many = new FormData();
      for (let i = 0; i < 50; i++) many.append(`field${i}`, "x");
      many.append("file", Buffer.from("x"), { filename: "fields.txt" });
      const tooMany = await send(many);
      expect(tooMany.status).toBe(HTTP_STATUS.PAYLOAD_TOO_LARGE);
      expect(tooMany.data.error).toBe("payload_too_large");

      const big = new FormData();
      big.append("note", "x".repeat(64 * 1024));
      big.append("file", Buffer.from("x"), { filename: "fields.txt" });
      const tooBig = await send(big);
      expect(tooBig.status).toBe(HTTP_STATUS.PAYLOAD_TOO_LARGE);
      expect(tooBig.data.error).toBe("payload_too_large");
    });

    it("should return 404 for non-existent bucket", async () => {
      const file = createTestFile("Test", "test.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      const response = await axios.put(
        `${BASE_URL}/buckets/non-existent/objects/test.txt`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });
  });

  describe("GET /buckets/:name/objects", () => {
    it("should list objects in bucket", async () => {
      // Upload a few test objects
      const file = createTestFile("Test content", "test.txt", "text/plain");
      await uploadTestObject(
        testToken,
        testBucket.name,
        "list-test-1.txt",
        file
      );
      await uploadTestObject(
        testToken,
        testBucket.name,
        "list-test-2.txt",
        file
      );

      const response = await axios.get<ObjectsListResponse>(
        `${BASE_URL}/buckets/${testBucket.name}/objects`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      const data = response.data;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.data).toBeDefined();
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.hasMore).toBeDefined();
      expect(data.nextCursor !== undefined).toBe(true);
      expect(data.data.length).toBeGreaterThan(0);
    });

    it("should support cursor pagination", async () => {
      const response = await axios.get<ObjectsListResponse>(
        `${BASE_URL}/buckets/${testBucket.name}/objects?limit=5`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      const data = response.data;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.limit).toBe(5);
      expect(
        data.nextCursor === null || typeof data.nextCursor === "string"
      ).toBe(true);
    });

    it("should support prefix filtering", async () => {
      const file = createTestFile("Test", "test.txt", "text/plain");
      await uploadTestObject(
        testToken,
        testBucket.name,
        "prefix/test-1.txt",
        file
      );
      await uploadTestObject(
        testToken,
        testBucket.name,
        "prefix/test-2.txt",
        file
      );
      await uploadTestObject(
        testToken,
        testBucket.name,
        "other/test.txt",
        file
      );

      const response = await axios.get<ObjectsListResponse>(
        `${BASE_URL}/buckets/${testBucket.name}/objects?filter[objectKey]=prefix/&filter[objectKey_op]=startsWith`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      const data = response.data;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.data.every((obj) => obj.key.startsWith("prefix/"))).toBe(
        true
      );
    });

    it("should support compound filters on the same field (startsWith + contains)", async () => {
      const file = createTestFile("Test", "test.txt", "text/plain");
      await uploadTestObject(
        testToken,
        testBucket.name,
        "compound/invoice-jan.txt",
        file
      );
      await uploadTestObject(
        testToken,
        testBucket.name,
        "compound/invoice-feb.txt",
        file
      );
      await uploadTestObject(
        testToken,
        testBucket.name,
        "compound/receipt-jan.txt",
        file
      );
      await uploadTestObject(
        testToken,
        testBucket.name,
        "elsewhere/invoice-jan.txt",
        file
      );

      const url =
        `${BASE_URL}/buckets/${testBucket.name}/objects` +
        `?filter[objectKey]=${encodeURIComponent("compound/")}` +
        `&filter[objectKey_op]=startsWith` +
        `&filter[objectKey]=invoice` +
        `&filter[objectKey_op]=contains` +
        `&limit=100`;

      const response = await axios.get<ObjectsListResponse>(url, {
        headers: { Authorization: `Bearer ${testToken}` },
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.OK);
      const keys = response.data.data.map((o) => o.key);
      expect(keys).toEqual(
        expect.arrayContaining([
          "compound/invoice-jan.txt",
          "compound/invoice-feb.txt",
        ])
      );
      expect(keys).not.toContain("compound/receipt-jan.txt");
      expect(keys).not.toContain("elsewhere/invoice-jan.txt");
    });
  });

  describe("GET /buckets/:name/objects/*", () => {
    it("should download an object", async () => {
      const content = "Download test content";
      const file = createTestFile(content, "download.txt", "text/plain");
      const objectKey = "download-test.txt";

      await uploadTestObject(testToken, testBucket.name, objectKey, file);

      const response = await axios.get(
        `${BASE_URL}/buckets/${testBucket.name}/objects/${objectKey}`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
          responseType: "text",
        }
      );

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.headers["content-type"]).toBe("text/plain");
      expect(response.headers["etag"]).toBeDefined();
      expect(response.headers["last-modified"]).toBeDefined();
      expect(response.headers["cache-control"]).toBeDefined();

      const downloadedContent = response.data;
      expect(downloadedContent).toBe(content);
    });

    it("should return 404 for non-existent object", async () => {
      const response = await axios.get(
        `${BASE_URL}/buckets/${testBucket.name}/objects/non-existent.txt`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });
  });

  describe("HEAD /buckets/:name/objects/*", () => {
    it("should get object metadata without content", async () => {
      const file = createTestFile("Metadata test", "meta.txt", "text/plain");
      const objectKey = "metadata-test.txt";

      await uploadTestObject(testToken, testBucket.name, objectKey, file);

      const response = await axios.head(
        `${BASE_URL}/buckets/${testBucket.name}/objects/${objectKey}`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.headers["content-type"]).toBe("text/plain");
      expect(response.headers["content-length"]).toBeDefined();
      expect(response.headers["etag"]).toBeDefined();
      expect(response.headers["last-modified"]).toBeDefined();

      // HEAD should not return body
      expect(response.data).toBe("");
    });

    it("should return 404 for non-existent object", async () => {
      const response = await axios.head(
        `${BASE_URL}/buckets/${testBucket.name}/objects/non-existent.txt`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });
  });

  describe("DELETE /buckets/:name/objects/*", () => {
    it("should delete an object", async () => {
      const file = createTestFile("Delete me", "delete.txt", "text/plain");
      const objectKey = "delete-test.txt";

      const { id } = await uploadTestObject(
        testToken,
        testBucket.name,
        objectKey,
        file
      );

      const response = await axios.delete(
        `${BASE_URL}/buckets/${testBucket.name}/objects/by-id/${id}`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);

      // Verify object is deleted
      const getResponse = await axios.get(
        `${BASE_URL}/buckets/${testBucket.name}/objects/${objectKey}`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(getResponse.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("should return 404 for non-existent object", async () => {
      const response = await axios.delete(
        `${BASE_URL}/buckets/${testBucket.name}/objects/by-id/00000000-0000-4000-8000-000000000000`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("should return 401 without authentication", async () => {
      const file = createTestFile("Test", "test.txt", "text/plain");
      const objectKey = "auth-delete-test.txt";

      const { id } = await uploadTestObject(
        testToken,
        testBucket.name,
        objectKey,
        file
      );

      const response = await axios.delete(
        `${BASE_URL}/buckets/${testBucket.name}/objects/by-id/${id}`,
        {
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });
  });

  describe("Public bucket access", () => {
    let publicBucket: { id: number; name: string; policy: string };

    beforeAll(async () => {
      publicBucket = await createTestBucket(testToken, { policy: "public" });
    });

    it("should allow anonymous download from public bucket", async () => {
      const file = createTestFile("Public content", "public.txt", "text/plain");
      const objectKey = "public-test.txt";

      await uploadTestObject(testToken, publicBucket.name, objectKey, file);

      // Download without authentication
      const response = await axios.get(
        `${BASE_URL}/buckets/${publicBucket.name}/objects/${objectKey}`,
        {
          validateStatus: () => true,
          responseType: "text",
        }
      );

      expect(response.status).toBe(HTTP_STATUS.OK);
      const content = response.data;
      expect(content).toBe("Public content");
    });

    it("should allow anonymous list from public bucket", async () => {
      // List without authentication
      const response = await axios.get<ObjectsListResponse>(
        `${BASE_URL}/buckets/${publicBucket.name}/objects`,
        {
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.OK);
      const data = response.data;
      expect(data.data).toBeDefined();
    });

    it("should require authentication for upload to public bucket", async () => {
      const file = createTestFile("Test", "test.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      const response = await axios.put(
        `${BASE_URL}/buckets/${publicBucket.name}/objects/no-auth.txt`,
        formData,
        {
          headers: formData.getHeaders(),
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });
  });

  describe("Storage Quota Enforcement", () => {
    let quotaBucket: { id: number; name: string; policy: string };

    beforeAll(async () => {
      // Create bucket with 1KB quota
      quotaBucket = await createTestBucket(testToken, {
        policy: "private",
        storageQuotaBytes: "1024", // 1KB
      });
    });

    it("should reject upload that exceeds bucket quota", async () => {
      const largeContent = "x".repeat(2000); // 2KB file
      const file = createTestFile(largeContent, "large.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      const response = await axios.put(
        `${BASE_URL}/buckets/${quotaBucket.name}/objects/large-file.txt`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.INSUFFICIENT_STORAGE);
      expect(response.data.error || response.data.error_description).toMatch(
        /quota|storage/i
      );
    });

    it("should allow upload within quota limits", async () => {
      const smallContent = "x".repeat(500); // 500 bytes
      const file = createTestFile(smallContent, "small.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      const response = await axios.put(
        `${BASE_URL}/buckets/${quotaBucket.name}/objects/small-file.txt`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
    });

    it("should track bucket usage after upload", async () => {
      const content = "test content for usage tracking";
      const file = createTestFile(content, "usage.txt", "text/plain");
      await uploadTestObject(
        testToken,
        quotaBucket.name,
        "usage-test.txt",
        file
      );

      const response = await axios.get(
        `${BASE_URL}/buckets/${quotaBucket.name}`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.OK);
      const currentUsage = parseInt(response.data.currentUsageBytes);
      expect(currentUsage).toBeGreaterThan(0);
    });

    it("should update usage when deleting object", async () => {
      const file = createTestFile("delete me", "delete.txt", "text/plain");
      const { id } = await uploadTestObject(
        testToken,
        quotaBucket.name,
        "delete-usage.txt",
        file
      );

      // Get usage before delete
      const beforeResponse = await axios.get(
        `${BASE_URL}/buckets/${quotaBucket.name}`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      const usageBefore = parseInt(beforeResponse.data.currentUsageBytes);

      // Delete object
      await axios.delete(
        `${BASE_URL}/buckets/${quotaBucket.name}/objects/by-id/${id}`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      // Get usage after delete
      const afterResponse = await axios.get(
        `${BASE_URL}/buckets/${quotaBucket.name}`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      const usageAfter = parseInt(afterResponse.data.currentUsageBytes);

      expect(usageAfter).toBeLessThan(usageBefore);
    });
  });

  describe("Object Key Validation", () => {
    it("should reject object key with path traversal (..)", async () => {
      const file = createTestFile("test", "test.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      // Clients normalize `folder/../file.txt` away before it is sent, so the
      // key carries a literal `..` that the URL keeps.
      const objectKeyWithDots = "test..file.txt";

      const response = await axios.put(
        `${BASE_URL}/buckets/${testBucket.name}/objects/${objectKeyWithDots}`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(response.data.error).toBe("invalid_request");
    });

    it("should reject object key starting with /", async () => {
      const file = createTestFile("test", "test.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      const response = await axios.put(
        `${BASE_URL}/buckets/${testBucket.name}/objects//absolute-path.txt`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should reject object key ending with /", async () => {
      const file = createTestFile("test", "test.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      const response = await axios.put(
        `${BASE_URL}/buckets/${testBucket.name}/objects/folder/`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should reject object key with consecutive slashes", async () => {
      const file = createTestFile("test", "test.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      const response = await axios.put(
        `${BASE_URL}/buckets/${testBucket.name}/objects/folder//file.txt`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should reject object key with invalid characters", async () => {
      const file = createTestFile("test", "test.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      const response = await axios.put(
        `${BASE_URL}/buckets/${testBucket.name}/objects/file<>:"|?.txt`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should reject object key exceeding 1024 characters", async () => {
      const file = createTestFile("test", "test.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      const longKey = "a".repeat(1025) + ".txt";
      const response = await axios.put(
        `${BASE_URL}/buckets/${testBucket.name}/objects/${longKey}`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should accept valid object key with slashes (folder structure)", async () => {
      const file = createTestFile("test", "test.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      const response = await axios.put(
        `${BASE_URL}/buckets/${testBucket.name}/objects/folder/subfolder/file.txt`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
    });

    it("should accept object key with valid special characters", async () => {
      const file = createTestFile("test", "test.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      const response = await axios.put(
        `${BASE_URL}/buckets/${testBucket.name}/objects/file_name-123.test.txt`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
    });
  });

  describe("Metadata Validation", () => {
    it("should accept valid metadata with string values", async () => {
      const file = createTestFile("test", "test.txt", "text/plain");
      const metadata = { author: "test-user", description: "test file" };
      const { formData, headers: metadataHeaders } = createFormDataWithMetadata(
        file,
        metadata
      );

      const response = await axios.put(
        `${BASE_URL}/buckets/${testBucket.name}/objects/metadata-string.txt`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
            ...metadataHeaders,
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.metadata).toBeDefined();
    });

    it("should accept metadata with number values", async () => {
      const file = createTestFile("test", "test.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      const metadata = { version: 1, size: 12345 };

      const response = await axios.put(
        `${BASE_URL}/buckets/${testBucket.name}/objects/metadata-number.txt`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
            "X-Metadata": JSON.stringify(metadata),
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
    });

    it("decodes non-ASCII metadata sent as \\u escapes, which keep the header ASCII", async () => {
      const file = createTestFile("test", "test.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      const metadata = { name: "日本語😀" };
      const header = JSON.stringify(metadata).replace(
        /[\u007f-\uffff]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
      );
      expect(header).toMatch(/^[\x20-\x7e]+$/);

      const response = await axios.put(
        `${BASE_URL}/buckets/${testBucket.name}/objects/metadata-unicode.txt`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
            "X-Metadata": header,
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(response.data.metadata).toMatchObject(metadata);
    });

    it("should accept metadata with boolean and null values", async () => {
      const file = createTestFile("test", "test.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      const metadata = { isPublic: true, deletedAt: null };

      const response = await axios.put(
        `${BASE_URL}/buckets/${testBucket.name}/objects/metadata-bool.txt`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
            "X-Metadata": JSON.stringify(metadata),
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
    });

    it("should accept metadata with array values", async () => {
      const file = createTestFile("test", "test.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      const metadata = { tags: ["tag1", "tag2", "tag3"], numbers: [1, 2, 3] };

      const response = await axios.put(
        `${BASE_URL}/buckets/${testBucket.name}/objects/metadata-array.txt`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
            "X-Metadata": JSON.stringify(metadata),
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
    });

    it("should reject metadata with key longer than 255 characters", async () => {
      const file = createTestFile("test", "test.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      const longKey = "a".repeat(256);
      const metadata = { [longKey]: "value" };

      const response = await axios.put(
        `${BASE_URL}/buckets/${testBucket.name}/objects/metadata-long-key.txt`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
            "X-Metadata": JSON.stringify(metadata),
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should reject metadata exceeding 100KB size", async () => {
      const file = createTestFile("test", "test.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      // Create metadata larger than 100KB
      // Use a smaller size that still exceeds 100KB when JSON stringified
      const largeValue = "x".repeat(100 * 1024 + 1000);
      const metadata = { data: largeValue };

      // The server accepts headers up to 200 KB (src/index.ts), so the
      // header reaches the 100 KB metadata check.
      const response = await axios.put(
        `${BASE_URL}/buckets/${testBucket.name}/objects/metadata-large.txt`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
            "X-Metadata": JSON.stringify(metadata),
          },
          validateStatus: () => true,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(response.data.error).toBe("x_metadata_header_too_large");
    });

    it("should reject metadata with more than 100 keys", async () => {
      const file = createTestFile("test", "test.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      // Create metadata with 101 keys
      const metadata: Record<string, string> = {};
      for (let i = 0; i < 101; i++) {
        metadata[`key${i}`] = "value";
      }

      const response = await axios.put(
        `${BASE_URL}/buckets/${testBucket.name}/objects/metadata-many-keys.txt`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
            "X-Metadata": JSON.stringify(metadata),
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should reject invalid JSON in metadata header", async () => {
      const file = createTestFile("test", "test.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      const response = await axios.put(
        `${BASE_URL}/buckets/${testBucket.name}/objects/metadata-invalid.txt`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
            "X-Metadata": "{invalid json}",
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should reject metadata with string value longer than 10000 chars", async () => {
      const file = createTestFile("test", "test.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      const longValue = "x".repeat(10001);
      const metadata = { description: longValue };

      const response = await axios.put(
        `${BASE_URL}/buckets/${testBucket.name}/objects/metadata-long-value.txt`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
            "X-Metadata": JSON.stringify(metadata),
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should reject metadata with array larger than 100 elements", async () => {
      const file = createTestFile("test", "test.txt", "text/plain");
      const formData = new FormData();
      formData.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      const largeArray = Array(101).fill("item");
      const metadata = { items: largeArray };

      const response = await axios.put(
        `${BASE_URL}/buckets/${testBucket.name}/objects/metadata-large-array.txt`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...formData.getHeaders(),
            "X-Metadata": JSON.stringify(metadata),
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });

  describe("Enhanced Pagination and Sorting", () => {
    // Its own bucket, so the sorts are checked against exactly these three:
    // by key aaa, mmm, zzz; by upload time aaa, zzz, mmm; by size zzz, mmm,
    // aaa.
    let sortBucket: { name: string };

    beforeAll(async () => {
      sortBucket = await createTestBucket(testToken, { policy: "private" });
      const uploads: Array<[string, string]> = [
        ["aaa-file.txt", "content 333"],
        ["zzz-file.txt", "content 1"],
        ["mmm-file.txt", "content 22"],
      ];
      for (const [key, content] of uploads) {
        const file = createTestFile(content, key, "text/plain");
        await uploadTestObject(testToken, testBucket.name, key, file);
        await uploadTestObject(testToken, sortBucket.name, key, file);
        // Distinct createdAt values.
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });

    it.each([
      ["objectKey", "asc", ["aaa-file.txt", "mmm-file.txt", "zzz-file.txt"]],
      ["objectKey", "desc", ["zzz-file.txt", "mmm-file.txt", "aaa-file.txt"]],
      ["createdAt", "asc", ["aaa-file.txt", "zzz-file.txt", "mmm-file.txt"]],
      ["createdAt", "desc", ["mmm-file.txt", "zzz-file.txt", "aaa-file.txt"]],
      ["sizeBytes", "asc", ["zzz-file.txt", "mmm-file.txt", "aaa-file.txt"]],
      ["sizeBytes", "desc", ["aaa-file.txt", "mmm-file.txt", "zzz-file.txt"]],
    ])("sorts by %s %s", async (sort, sortDir, expected) => {
      const response = await axios.get(
        `${BASE_URL}/buckets/${sortBucket.name}/objects`,
        {
          params: { sort, sortDir },
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.data.map((obj: { key: string }) => obj.key)).toEqual(
        expected
      );
    });

    it("should respect limit parameter (minimum 1)", async () => {
      const response = await axios.get(
        `${BASE_URL}/buckets/${testBucket.name}/objects?limit=2`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.data.length).toBeLessThanOrEqual(2);
      expect(response.data.limit).toBe(2);
    });

    it("should respect maximum limit of 1000", async () => {
      const response = await axios.get(
        `${BASE_URL}/buckets/${testBucket.name}/objects?limit=1001`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should walk through pages via cursor", async () => {
      const firstPage = await axios.get<ObjectsListResponse>(
        `${BASE_URL}/buckets/${testBucket.name}/objects?limit=1`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(firstPage.status).toBe(HTTP_STATUS.OK);
      expect(firstPage.data.hasMore).toBe(true);
      expect(firstPage.data.nextCursor).toEqual(expect.any(String));

      const secondPage = await axios.get<ObjectsListResponse>(
        `${BASE_URL}/buckets/${testBucket.name}/objects?limit=1&cursor=${encodeURIComponent(firstPage.data.nextCursor!)}`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(secondPage.status).toBe(HTTP_STATUS.OK);
      expect(firstPage.data.data).toHaveLength(1);
      expect(secondPage.data.data).toHaveLength(1);
      expect(firstPage.data.data[0].id).not.toBe(secondPage.data.data[0].id);
    });

    it("should reject a malformed cursor with 400", async () => {
      const response = await axios.get(
        `${BASE_URL}/buckets/${testBucket.name}/objects?limit=5&cursor=not-a-real-cursor`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );
      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("should correctly report hasMore flag", async () => {
      // With many objects seeded above, limiting to 1 should set hasMore=true.
      const limitedResponse = await axios.get<ObjectsListResponse>(
        `${BASE_URL}/buckets/${testBucket.name}/objects?limit=1`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(limitedResponse.status).toBe(HTTP_STATUS.OK);
      expect(limitedResponse.data.data).toHaveLength(1);
      expect(limitedResponse.data.hasMore).toBe(true);
      expect(limitedResponse.data.nextCursor).not.toBeNull();
    });

    it("should return hasMore as false when at end of results", async () => {
      const response = await axios.get(
        `${BASE_URL}/buckets/${testBucket.name}/objects?limit=1000`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.data.hasMore).toBe(false);
    });
  });
});
