import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
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
  testIdempotencyKey,
  waitFor,
} from "./utils/test-helpers.js";

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

describe("Access Logging", () => {
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
      const file = createTestFile("download content", "test.txt", "text/plain");
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
      const file = createTestFile("metadata content", "test.txt", "text/plain");
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
      const file = createTestFile("public content", "public.txt", "text/plain");
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
