// @module-tag int
// @module-tag files
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import FormData from "form-data";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createFormDataWithMetadata,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  testIdempotencyKey,
} from "../../../../../../../support/files.js";

describe("PUT /v1/files/buckets/:name/objects/*objectKey", () => {
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
        const { formData, headers: metadataHeaders } =
          createFormDataWithMetadata(file, metadata);

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

    describe("X-Tags forms", () => {
      const putWithTags = async (bucketName: string, xTags: string) => {
        const file = createTestFile("tagged", "tagged.txt", "text/plain");
        const form = new FormData();
        form.append("file", file.buffer, {
          filename: file.filename,
          contentType: file.contentType,
        });
        return await axios.put(
          `${BASE_URL}/buckets/${bucketName}/objects/tagged.txt`,
          form,
          {
            headers: {
              ...authHeader(testToken),
              ...form.getHeaders(),
              "Idempotency-Key": testIdempotencyKey(),
              "X-Tags": xTags,
            },
            validateStatus: () => true,
          }
        );
      };
      const asciiJson = (value: unknown) =>
        JSON.stringify(value).replace(
          /[\u0080-\uffff]/g,
          (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
        );

      it("reads a JSON array, so tags may hold any character and commas", async () => {
        const bucket = await createTestBucket(testToken, { policy: "private" });
        const header = asciiJson(["日本語", "a,b"]);
        expect(header).toMatch(/^[\x20-\x7e]+$/);
        const put = await putWithTags(bucket.name, header);
        expect(put.status).toBe(HTTP_STATUS.CREATED);
        expect(put.data.tags).toEqual(["日本語", "a,b"]);
      });

      it("still reads the comma-separated form", async () => {
        const bucket = await createTestBucket(testToken, { policy: "private" });
        const put = await putWithTags(bucket.name, " alpha ,, bravo");
        expect(put.status).toBe(HTTP_STATUS.CREATED);
        expect(put.data.tags).toEqual(["alpha", "bravo"]);
      });

      it.each([
        ["invalid JSON", '["a", '],
        ["a comma-form value starting with [", "[draft], final"],
        ["a non-string entry", '["a", 1]'],
        ["an empty tag", '["a", ""]'],
        ["an object", '[{"a":1}]'],
      ])("refuses %s rather than reading it as commas", async (_, header) => {
        const bucket = await createTestBucket(testToken, { policy: "private" });
        const put = await putWithTags(bucket.name, header);
        expect(put.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(put.data.error).toBe("invalid_request");
      });

      it("applies the count and length limits to the JSON form", async () => {
        const bucket = await createTestBucket(testToken, { policy: "private" });
        const tooMany = await putWithTags(
          bucket.name,
          JSON.stringify(Array.from({ length: 51 }, (_, i) => `t${i}`))
        );
        expect(tooMany.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(tooMany.data.error).toBe("too_many_tags");
        const tooLong = await putWithTags(
          bucket.name,
          JSON.stringify(["x".repeat(129)])
        );
        expect(tooLong.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(tooLong.data.error).toBe("tag_too_long");
      });
    });
  });

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

    it("refuses a content type longer than the column holds", async () => {
      const bucket = await createTestBucket(token);
      const res = await put(
        token,
        bucket.name,
        "long.txt",
        "text",
        {},
        `text/${"a".repeat(300)}`
      );
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(res.data.error).toBe("invalid_content_type");
    });
  });
});
