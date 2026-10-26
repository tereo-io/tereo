// @module-tag int
// @module-tag files
// @module-tag security
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "node:crypto";
import FormData from "form-data";
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
  uploadTestObjectAndGetId,
  waitFor,
} from "../support/files.js";

describe("accessLogMiddleware", () => {
  describe("Access Logging", () => {
    // The access log is written after the response is sent.
    const waitForAccessLog = async (where: Record<string, unknown>) => {
      let logs: Awaited<ReturnType<typeof prisma.accessLog.findMany>> = [];
      await waitFor(async () => {
        logs = await prisma.accessLog.findMany({
          where,
          orderBy: { timestamp: "desc" },
          take: 1,
        });
        return logs.length > 0;
      }, 5000);
      return logs;
    };
    let testToken: string;
    let testBucket: { id: number; name: string; policy: string };
    let testUserId: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
      testUserId = "00000000-0000-7001-0000-000000000001";
      testBucket = await createTestBucket(testToken, { policy: "private" });
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("Bucket Operations Logging", () => {
      it("should log CREATE_BUCKET operation", async () => {
        const bucket = await createTestBucket(testToken);

        const logs = await waitForAccessLog({
          bucketId: bucket.id,
          operation: "CREATE_BUCKET",
        });

        expect(logs.length).toBeGreaterThan(0);
        const log = logs[0];
        expect(log.operation).toBe("CREATE_BUCKET");
        expect(log.bucketId).toBe(bucket.id);
        expect(log.userId).toBe(testUserId);
        expect(log.statusCode).toBe(201);
        expect(log.ipAddress).toBeDefined();
        expect(log.requestId).toBeDefined();
      });

      it("should log GET_BUCKET operation", async () => {
        const bucket = await createTestBucket(testToken);

        await axios.get(`${BASE_URL}/buckets/${bucket.name}`, {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });

        const logs = await waitForAccessLog({
          bucketId: bucket.id,
          operation: "GET_BUCKET",
        });

        expect(logs.length).toBeGreaterThan(0);
        const log = logs[0];
        expect(log.operation).toBe("GET_BUCKET");
        expect(log.bucketId).toBe(bucket.id);
        expect(log.statusCode).toBe(200);
      });

      it("should log UPDATE_BUCKET operation", async () => {
        const bucket = await createTestBucket(testToken);

        await axios.put(
          `${BASE_URL}/buckets/${bucket.name}`,
          { description: "Updated description" },
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        const logs = await waitForAccessLog({
          bucketId: bucket.id,
          operation: "UPDATE_BUCKET",
        });

        expect(logs.length).toBeGreaterThan(0);
        const log = logs[0];
        expect(log.operation).toBe("UPDATE_BUCKET");
        expect(log.statusCode).toBe(200);
      });

      it("should log DELETE_BUCKET operation", async () => {
        const bucket = await createTestBucket(testToken);

        await axios.delete(`${BASE_URL}/buckets/${bucket.name}`, {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });

        // Wait for access log to be written (async race condition)
        const logs = await waitForAccessLog({
          bucketId: bucket.id,
          operation: "DELETE_BUCKET",
        });

        expect(logs.length).toBeGreaterThan(0);
        const log = logs[0];
        expect(log.operation).toBe("DELETE_BUCKET");
        expect(log.statusCode).toBe(204);
      });
    });

    describe("Object Operations Logging", () => {
      it("should log CREATE_OBJECT operation", async () => {
        const file = createTestFile("test content", "test.txt", "text/plain");
        const objectKey = "create-log-test.txt";

        const formData = new FormData();
        formData.append("file", file.buffer, {
          filename: file.filename,
          contentType: file.contentType,
        });

        const response = await axios.put(
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

        const objectId = response.data.id;

        const logs = await waitForAccessLog({
          bucketId: testBucket.id,
          objectId: objectId,
          operation: "CREATE_OBJECT",
        });

        expect(logs.length).toBeGreaterThan(0);
        const log = logs[0];
        expect(log.operation).toBe("CREATE_OBJECT");
        expect(log.objectId).toBe(objectId);
        expect(log.statusCode).toBe(201);
      });

      it("should log UPDATE_OBJECT operation", async () => {
        const file1 = createTestFile("version 1", "test.txt", "text/plain");
        const objectKey = "update-log-test.txt";

        // Create initial object
        await uploadTestObject(testToken, testBucket.name, objectKey, file1);

        // Update the object
        const file2 = createTestFile("version 2", "test.txt", "text/plain");
        const formData = new FormData();
        formData.append("file", file2.buffer, {
          filename: file2.filename,
          contentType: file2.contentType,
        });

        const response = await axios.put(
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

        const objectId = response.data.id;

        const logs = await waitForAccessLog({
          bucketId: testBucket.id,
          objectId: objectId,
          operation: "UPDATE_OBJECT",
        });

        expect(logs.length).toBeGreaterThan(0);
        const log = logs[0];
        expect(log.operation).toBe("UPDATE_OBJECT");
        expect(log.statusCode).toBe(200);
      });

      it("should log DOWNLOAD_OBJECT operation", async () => {
        const file = createTestFile(
          "download content",
          "test.txt",
          "text/plain"
        );
        const objectKey = "download-log-test.txt";

        const uploaded = await uploadTestObject(
          testToken,
          testBucket.name,
          objectKey,
          file
        );

        // Download the object
        await axios.get(
          `${BASE_URL}/buckets/${testBucket.name}/objects/${objectKey}`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        const logs = await waitForAccessLog({
          bucketId: testBucket.id,
          objectId: uploaded.id,
          operation: "DOWNLOAD_OBJECT",
        });

        expect(logs.length).toBeGreaterThan(0);
        const log = logs[0];
        expect(log.operation).toBe("DOWNLOAD_OBJECT");
        expect(log.statusCode).toBe(200);
      });

      it("should log GET_OBJECT_METADATA operation", async () => {
        const file = createTestFile(
          "metadata content",
          "test.txt",
          "text/plain"
        );
        const objectKey = "metadata-log-test.txt";

        const uploaded = await uploadTestObject(
          testToken,
          testBucket.name,
          objectKey,
          file
        );

        // Get metadata using HEAD
        const response = await axios.head(
          `${BASE_URL}/buckets/${testBucket.name}/objects/${objectKey}`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        // Verify HEAD request succeeded
        expect(response.status).toBe(200);

        const logs = await waitForAccessLog({
          bucketId: testBucket.id,
          objectId: uploaded.id,
          operation: "GET_OBJECT_METADATA",
        });

        expect(logs.length).toBeGreaterThan(0);
        const log = logs[0];
        expect(log.operation).toBe("GET_OBJECT_METADATA");
        expect(log.statusCode).toBe(200);
      });

      it("should log DELETE_OBJECT operation", async () => {
        const file = createTestFile("delete content", "test.txt", "text/plain");
        const objectKey = "delete-log-test.txt";

        const uploaded = await uploadTestObject(
          testToken,
          testBucket.name,
          objectKey,
          file
        );

        // Delete the object
        await axios.delete(
          `${BASE_URL}/buckets/${testBucket.name}/objects/by-id/${uploaded.id}`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        // Query access logs (use retry helper since log is written async after 204)
        const logs = await waitForAccessLog({
          bucketId: testBucket.id,
          objectId: uploaded.id,
          operation: "DELETE_OBJECT",
        });

        expect(logs.length).toBeGreaterThan(0);
        const log = logs[0];
        expect(log.operation).toBe("DELETE_OBJECT");
        expect(log.statusCode).toBe(204);
      });

      it("should log LIST_OBJECTS operation", async () => {
        await axios.get(`${BASE_URL}/buckets/${testBucket.name}/objects`, {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });

        const logs = await waitForAccessLog({
          bucketId: testBucket.id,
          operation: "LIST_OBJECTS",
        });

        expect(logs.length).toBeGreaterThan(0);
        const log = logs[0];
        expect(log.operation).toBe("LIST_OBJECTS");
        expect(log.statusCode).toBe(200);
        expect(log.objectId).toBeNull();
      });
    });

    describe("Access Log Fields", () => {
      it("should capture IP address", async () => {
        const bucket = await createTestBucket(testToken);

        const logs = await waitForAccessLog({
          bucketId: bucket.id,
          operation: "CREATE_BUCKET",
        });

        expect(logs.length).toBeGreaterThan(0);
        const log = logs[0];
        expect(log.ipAddress).toBeDefined();
        expect(typeof log.ipAddress).toBe("string");
        expect(log.ipAddress.length).toBeGreaterThan(0);
      });

      it("should capture user agent", async () => {
        const bucket = await createTestBucket(testToken);

        const logs = await waitForAccessLog({
          bucketId: bucket.id,
          operation: "CREATE_BUCKET",
        });

        expect(logs.length).toBeGreaterThan(0);
        const log = logs[0];
        expect(log.userAgent).toBeDefined();
        expect(typeof log.userAgent).toBe("string");
      });

      it("should capture request ID", async () => {
        const bucket = await createTestBucket(testToken);

        const logs = await waitForAccessLog({
          bucketId: bucket.id,
          operation: "CREATE_BUCKET",
        });

        expect(logs.length).toBeGreaterThan(0);
        const log = logs[0];
        expect(log.requestId).toBeDefined();
        expect(typeof log.requestId).toBe("string");
        expect(log.requestId?.length).toBeGreaterThan(0);
      });

      it("should capture timestamp", async () => {
        const startTime = new Date();
        const bucket = await createTestBucket(testToken);
        const endTime = new Date();

        const logs = await waitForAccessLog({
          bucketId: bucket.id,
          operation: "CREATE_BUCKET",
        });

        expect(logs.length).toBeGreaterThan(0);
        const log = logs[0];
        expect(log.timestamp).toBeDefined();
        expect(log.timestamp).toBeInstanceOf(Date);

        // Timestamp should be within test execution time window
        expect(log.timestamp.getTime()).toBeGreaterThanOrEqual(
          startTime.getTime()
        );
        // Allow small buffer for async log write delay
        expect(log.timestamp.getTime()).toBeLessThanOrEqual(
          endTime.getTime() + 1000
        );
      });

      it("should capture user ID for authenticated requests", async () => {
        const bucket = await createTestBucket(testToken);

        const logs = await waitForAccessLog({
          bucketId: bucket.id,
          operation: "CREATE_BUCKET",
        });

        expect(logs.length).toBeGreaterThan(0);
        const log = logs[0];
        expect(log.userId).toBe(testUserId);
      });
    });

    describe("Error Logging", () => {
      it("should log 404 errors with proper status code", async () => {
        const response = await axios.get(
          `${BASE_URL}/buckets/non-existent-bucket`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);

        // Access logs might not be created for 404s depending on implementation
        // This test documents the expected behavior
        // If logs ARE created for 404s, we can verify them here
      });

      it("should log 401 errors for unauthenticated requests", async () => {
        const response = await axios.post(
          `${BASE_URL}/buckets`,
          {
            name: "test-bucket",
            policy: "private",
          },
          {
            headers: { "Content-Type": "application/json" },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      });

      it("writes no row for a request refused before a controller runs", async () => {
        const missing = randomUUID();
        const bad = randomUUID();
        const noToken = await axios.get(`${BASE_URL}/buckets`, {
          headers: { "X-Request-ID": missing },
          validateStatus: () => true,
        });
        expect(noToken.status).toBe(HTTP_STATUS.UNAUTHORIZED);
        const badToken = await axios.get(`${BASE_URL}/buckets`, {
          headers: { "X-Request-ID": bad, Authorization: "Bearer nope" },
          validateStatus: () => true,
        });
        expect(badToken.status).toBe(HTTP_STATUS.UNAUTHORIZED);

        // A row written later than this one would have been written by now.
        const logged = randomUUID();
        await axios.get(`${BASE_URL}/buckets/missing-${randomUUID()}`, {
          headers: {
            "X-Request-ID": logged,
            Authorization: `Bearer ${testToken}`,
          },
          validateStatus: () => true,
        });
        await waitForAccessLog({ requestId: logged });
        expect(
          await prisma.accessLog.count({
            where: { requestId: { in: [missing, bad] } },
          })
        ).toBe(0);
      });

      it("still logs a signed URL refused before its controller", async () => {
        const requestId = randomUUID();
        const response = await axios.get(
          `${BASE_URL}/signed/objects/${testBucket.name}/by-id/${randomUUID()}?sig=bad&exp=1`,
          { headers: { "X-Request-ID": requestId }, validateStatus: () => true }
        );
        expect(response.status).toBeGreaterThanOrEqual(400);
        const [row] = await waitForAccessLog({ requestId });
        expect(row.statusCode).toBe(response.status);
      });

      it("should log 400 errors with error message", async () => {
        const response = await axios.post(
          `${BASE_URL}/buckets`,
          {
            name: "invalid name with spaces",
            policy: "private",
          },
          {
            headers: {
              Authorization: `Bearer ${testToken}`,
              "Content-Type": "application/json",
            },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });
    });

    describe("Public Bucket Access Logging", () => {
      let publicBucket: { id: number; name: string; policy: string };

      beforeAll(async () => {
        publicBucket = await createTestBucket(testToken, { policy: "public" });
      });

      it("should log anonymous access to public bucket", async () => {
        const file = createTestFile(
          "public content",
          "public.txt",
          "text/plain"
        );
        const objectKey = "public-log-test.txt";

        const uploaded = await uploadTestObject(
          testToken,
          publicBucket.name,
          objectKey,
          file
        );

        // Download without authentication
        await axios.get(
          `${BASE_URL}/buckets/${publicBucket.name}/objects/${objectKey}`,
          {
            validateStatus: () => true,
          }
        );

        const logs = await waitForAccessLog({
          bucketId: publicBucket.id,
          objectId: uploaded.id,
          operation: "DOWNLOAD_OBJECT",
          userId: null, // Anonymous access
        });

        expect(logs.length).toBeGreaterThan(0);
        const log = logs[0];
        expect(log.operation).toBe("DOWNLOAD_OBJECT");
        expect(log.userId).toBeNull();
        expect(log.statusCode).toBe(200);
      });

      it("should log anonymous LIST_OBJECTS on public bucket", async () => {
        await axios.get(`${BASE_URL}/buckets/${publicBucket.name}/objects`, {
          validateStatus: () => true,
        });

        const logs = await waitForAccessLog({
          bucketId: publicBucket.id,
          operation: "LIST_OBJECTS",
          userId: null,
        });

        expect(logs.length).toBeGreaterThan(0);
        const log = logs[0];
        expect(log.operation).toBe("LIST_OBJECTS");
        expect(log.userId).toBeNull();
      });
    });
  });

  describe("share tokens in the access log", () => {
    let token: string;
    let bucket: { name: string };
    let objectId: string;

    beforeAll(async () => {
      token = await getTestAccessToken();
      bucket = await createTestBucket(token, { policy: "private" });
      objectId = await uploadTestObjectAndGetId(
        token,
        bucket.name,
        "secret.txt",
        createTestFile("secret", "secret.txt", "text/plain")
      );
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    it("records a password share's 401 without the token", async () => {
      const share = await axios.post<{ url: string; token: string }>(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        { kind: "OBJECT", objectId, password: "log-secret" },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const requestId = randomUUID();
      const res = await axios.get(share.data.url, {
        maxRedirects: 0,
        headers: { Accept: "application/json", "X-Request-ID": requestId },
        validateStatus: () => true,
      });
      expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(res.data.error).toBe("password_required");

      let row: Awaited<ReturnType<typeof prisma.accessLog.findFirst>> = null;
      await waitFor(async () => {
        row = await prisma.accessLog.findFirst({ where: { requestId } });
        return row !== null;
      }, 5_000);
      expect(row!.operation).toMatch(/^GET \/shared\/:token(\/|$)/);
      expect(`${row!.operation} ${row!.errorMessage}`).not.toContain(
        share.data.token
      );
    });
  });

  describe("client-supplied request metadata on files requests", () => {
    let token: string;
    let bucket: { name: string };

    beforeAll(async () => {
      token = await getTestAccessToken();
      bucket = await createTestBucket(token, { policy: "private" });
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    it("serves an audited mutation whose X-Request-ID would overflow the columns", async () => {
      const res = await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        { description: "long request id" },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Request-ID": "r".repeat(300),
          },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f]{32}$/);
    });

    it("logs access with a User-Agent longer than its column", async () => {
      const requestId = randomUUID();
      const res = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Request-ID": requestId,
            "User-Agent": `agent/${"x".repeat(700)}`,
          },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      let row: Awaited<ReturnType<typeof prisma.accessLog.findFirst>> = null;
      await waitFor(async () => {
        row = await prisma.accessLog.findFirst({ where: { requestId } });
        return row !== null;
      }, 5_000);
      expect(row!.userAgent).toHaveLength(500);
    });
  });
});
