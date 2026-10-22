// @module-tag int
// @module-tag files
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
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
  uploadTestObject,
} from "../../../../../../../support/files.js";

describe("PUT /v1/files/buckets/:name/objects/*objectKey", () => {
  describe("Object Management", () => {
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

        const { formData, headers: metadataHeaders } =
          createFormDataWithMetadata(file, metadata);

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
  });

  describe("File Service Overhaul — end-to-end flows", () => {
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

    describe("Tags", () => {
      it("persists tags supplied via the X-Tags header", async () => {
        const bucket = await createTestBucket(testToken, { policy: "private" });
        const file = createTestFile("tagged", "tagged.txt", "text/plain");
        const form = new FormData();
        form.append("file", file.buffer, {
          filename: file.filename,
          contentType: file.contentType,
        });

        const put = await axios.put<ObjectResponse>(
          `${BASE_URL}/buckets/${bucket.name}/objects/tagged.txt`,
          form,
          {
            headers: {
              ...authHeader(testToken),
              ...form.getHeaders(),
              "Idempotency-Key": testIdempotencyKey(),
              "X-Tags": "alpha, bravo",
            },
          }
        );
        expect(put.status).toBe(HTTP_STATUS.CREATED);
        expect(put.data.tags).toEqual(["alpha", "bravo"]);

        const list = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects`,
          { headers: authHeader(testToken) }
        );
        const row = list.data.data.find(
          (o: ObjectResponse) => o.key === "tagged.txt"
        );
        expect(row.tags).toEqual(["alpha", "bravo"]);
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

    describe("If-None-Match: * on upload", () => {
      it("replays a retried create under the same Idempotency-Key", async () => {
        const bucket = await createTestBucket(token);
        const key = testIdempotencyKey();
        const body = `once ${randomUUID()}`;
        const headers = { "If-None-Match": "*", "Idempotency-Key": key };

        const first = await put(token, bucket.name, "once.txt", body, headers);
        expect(first.status).toBe(HTTP_STATUS.CREATED);

        const retry = await put(token, bucket.name, "once.txt", body, headers);
        expect(retry.status).toBe(HTTP_STATUS.CREATED);
        expect(retry.headers["idempotency-replay"]).toBe("true");
        expect(retry.data.id).toBe(first.data.id);

        const other = await put(token, bucket.name, "once.txt", body, {
          "If-None-Match": "*",
        });
        expect(other.status).toBe(412);
        expect(other.data.error).toBe("precondition_failed");
      });
    });

    describe("If-Match on upload", () => {
      it("replaces only when the ETag matches", async () => {
        const bucket = await createTestBucket(token);
        const first = await uploadTestObject(
          token,
          bucket.name,
          "doc.txt",
          createTestFile(`v1 ${randomUUID()}`)
        );

        const stale = await put(
          token,
          bucket.name,
          "doc.txt",
          `v2 ${randomUUID()}`,
          {
            "If-Match": '"0123456789abcdef0123456789abcdef"',
          }
        );
        expect(stale.status).toBe(412);

        const fresh = await put(
          token,
          bucket.name,
          "doc.txt",
          `v2 ${randomUUID()}`,
          {
            "If-Match": `"${first.etag}"`,
          }
        );
        expect(fresh.status).toBe(HTTP_STATUS.OK);

        const missing = await put(
          token,
          bucket.name,
          "nope.txt",
          `v1 ${randomUUID()}`,
          {
            "If-Match": "*",
          }
        );
        expect(missing.status).toBe(412);
      });
    });
  });

  describe("download responses", () => {
    const text = (content: string) => createTestFile(content, "a.txt");
    let token: string;
    let bucket: { id: number; name: string };
    const url = () => `${BASE_URL}/buckets/${bucket.name}/objects/doc.txt`;

    const req = (
      method: "get" | "head",
      target: string,
      headers: Record<string, string> = {},
      params: Record<string, string> = {}
    ) =>
      axios.request({
        method,
        url: target,
        params,
        headers: { Authorization: `Bearer ${token}`, ...headers },
        validateStatus: () => true,
      });

    beforeAll(async () => {
      token = await getTestAccessToken();
      bucket = await createTestBucket(token);
      await uploadTestObject(
        token,
        bucket.name,
        "doc.txt",
        text("second, longer")
      );
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("PUT preconditions", () => {
      const put = (headers: Record<string, string>) => {
        const form = new FormData();
        form.append("file", Buffer.from(`next ${randomUUID()}`), {
          filename: "a.txt",
          contentType: "text/plain",
        });
        return axios.put(url(), form, {
          headers: {
            Authorization: `Bearer ${token}`,
            "Idempotency-Key": testIdempotencyKey(),
            ...form.getHeaders(),
            ...headers,
          },
          validateStatus: () => true,
        });
      };

      it("refuses If-None-Match naming the current ETag, weakly compared", async () => {
        const head = await req("head", url());
        const etag = head.headers.etag as string;
        expect((await put({ "If-None-Match": etag })).status).toBe(412);
        expect((await put({ "If-None-Match": `"x", W/${etag}` })).status).toBe(
          412
        );
        expect((await put({ "If-None-Match": '"other"' })).status).toBe(
          HTTP_STATUS.OK
        );
      });

      it("refuses a weak If-Match", async () => {
        const etag = (await req("head", url())).headers.etag as string;
        expect((await put({ "If-Match": `W/${etag}` })).status).toBe(412);
        expect((await put({ "If-Match": etag })).status).toBe(HTTP_STATUS.OK);
      });
    });
  });
});
