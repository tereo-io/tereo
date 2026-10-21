import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestPrincipalToken } from "../utils/principals.js";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  createTestBucket,
  createTestFile,
  cleanupTestEntities,
  generateUniqueId,
  uploadTestObject,
} from "./utils/test-helpers.js";

interface BucketResponse {
  id: number;
  name: string;
  description?: string;
  policy: "public" | "private";
  organizationId: string | null;
  storageQuotaBytes?: string | null;
  currentUsageBytes: string;
  createdAt: string;
  updatedAt?: string;
  corsConfig?: Record<string, unknown> | null;
  rateLimitConfig?: Record<string, unknown> | null;
}

interface BucketsListResponse {
  data: BucketResponse[];
  total: number;
  hasMore: boolean;
}

interface ErrorResponse {
  error?: string;
  error_description?: string;
}

describe("Bucket Management", () => {
  let testToken: string;

  beforeAll(async () => {
    testToken = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("POST /buckets", () => {
    it("refuses a name in a declared namespace", async () => {
      for (const ns of ["core", "auth-service"]) {
        const response = await axios.post(
          `${BASE_URL}/buckets`,
          { name: `${ns}-${generateUniqueId()}`, policy: "private" },
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );
        expect(response.status).toBe(HTTP_STATUS.CONFLICT);
      }
    });

    it("should create a new bucket with valid data", async () => {
      const uniqueId = generateUniqueId();
      const bucketData = {
        name: `test-bucket-${uniqueId}`,
        description: "Test bucket for testing",
        policy: "private" as const,
        storageQuotaBytes: null,
      };

      const response = await axios.post<BucketResponse>(
        `${BASE_URL}/buckets`,
        bucketData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      const data = response.data;

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(data.id).toBeDefined();
      expect(data.name).toBe(bucketData.name);
      expect(data.description).toBe(bucketData.description);
      expect(data.policy).toBe(bucketData.policy);
      expect(data.currentUsageBytes).toBe("0");
      expect(data.createdAt).toBeDefined();
    });

    it("should create a bucket with storage quota", async () => {
      const uniqueId = generateUniqueId();
      const bucketData = {
        name: `test-bucket-quota-${uniqueId}`,
        description: "Bucket with quota",
        policy: "private" as const,
        storageQuotaBytes: "1073741824", // 1GB
      };

      const response = await axios.post<BucketResponse>(
        `${BASE_URL}/buckets`,
        bucketData,
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      const data = response.data;

      expect(response.status).toBe(HTTP_STATUS.CREATED);
      expect(data.storageQuotaBytes).toBe(bucketData.storageQuotaBytes);
    });

    it("should return 401 without authentication", async () => {
      const response = await axios.post(
        `${BASE_URL}/buckets`,
        { name: "unauthorized-bucket", policy: "private" },
        {
          headers: { "Content-Type": "application/json" },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it("should return 409 for duplicate bucket name", async () => {
      const bucket = await createTestBucket(testToken);

      const response = await axios.post<ErrorResponse>(
        `${BASE_URL}/buckets`,
        { name: bucket.name, policy: "private" },
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CONFLICT);

      const data = response.data;
      expect(data.error || data.error_description).toBeDefined();
    });

    it("should return 400 for invalid bucket name", async () => {
      const response = await axios.post(
        `${BASE_URL}/buckets`,
        { name: "invalid name with spaces", policy: "private" },
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

    it("should return 400 for bucket name with uppercase letters", async () => {
      const response = await axios.post(
        `${BASE_URL}/buckets`,
        { name: "InvalidBucket", policy: "private" },
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

    it("should return 400 for bucket name shorter than 3 characters", async () => {
      const response = await axios.post(
        `${BASE_URL}/buckets`,
        { name: "ab", policy: "private" },
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

    it("should return 400 for bucket name longer than 63 characters", async () => {
      const response = await axios.post(
        `${BASE_URL}/buckets`,
        { name: "a".repeat(64), policy: "private" },
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

    it("should return 400 for bucket name starting with hyphen", async () => {
      const response = await axios.post(
        `${BASE_URL}/buckets`,
        { name: "-invalid-bucket", policy: "private" },
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

    it("should return 400 for bucket name ending with hyphen", async () => {
      const response = await axios.post(
        `${BASE_URL}/buckets`,
        {
          name: "invalid-bucket-",
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

    it("should return 400 for bucket name with special characters", async () => {
      const response = await axios.post(
        `${BASE_URL}/buckets`,
        { name: "bucket_name!@#", policy: "private" },
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

    it("should accept valid bucket name with hyphens", async () => {
      const uniqueId = generateUniqueId();
      const response = await axios.post(
        `${BASE_URL}/buckets`,
        { name: `valid-bucket-name-${uniqueId}`, policy: "private" },
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
    });

    it("should accept valid bucket name with numbers", async () => {
      const uniqueId = generateUniqueId();
      const response = await axios.post(
        `${BASE_URL}/buckets`,
        { name: `bucket123-${uniqueId}`, policy: "private" },
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.CREATED);
    });

    it("should return 400 for storage quota exceeding maximum (1TB)", async () => {
      const uniqueId = generateUniqueId();
      const overLimit = "1099511627777"; // Just over 1TB

      const response = await axios.post(
        `${BASE_URL}/buckets`,
        {
          name: `bucket-over-quota-${uniqueId}`,
          policy: "private",
          storageQuotaBytes: overLimit,
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

  describe("GET /buckets", () => {
    it("should list all buckets user has access to", async () => {
      // Create a test bucket first
      await createTestBucket(testToken);

      const response = await axios.get<BucketsListResponse>(
        `${BASE_URL}/buckets`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      const data = response.data;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.data).toBeDefined();
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data.length).toBeGreaterThan(0);

      // Verify bucket structure
      const bucket = data.data[0];
      expect(bucket.id).toBeDefined();
      expect(bucket.name).toBeDefined();
      expect(bucket.policy).toBeDefined();
      expect(bucket.currentUsageBytes).toBeDefined();
    });

    it("should return 401 without authentication", async () => {
      const response = await axios.get(`${BASE_URL}/buckets`, {
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });
  });

  describe("GET /buckets paging", () => {
    const walk = async (owner: string, sort: string, sortDir: string) => {
      const names: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const params: Record<string, string | number> = {
          sort,
          sortDir,
          limit: 1,
        };
        if (cursor) params.cursor = cursor;
        const res = await axios.get<{
          data: BucketResponse[];
          hasMore: boolean;
          nextCursor: string | null;
        }>(`${BASE_URL}/buckets`, {
          headers: { Authorization: `Bearer ${owner}` },
          params,
          validateStatus: () => true,
        });
        expect([sort, sortDir, res.status]).toEqual([sort, sortDir, 200]);
        names.push(...res.data.data.map((b: BucketResponse) => b.name));
        cursor = res.data.nextCursor;
        if (!res.data.hasMore) break;
      }
      return names;
    };

    it("pages through a BigInt and a nullable sort field", async () => {
      const owner = await getTestPrincipalToken({
        organizationId: `bucket-paging-${generateUniqueId()}`,
        permissions: [
          "file-service.buckets.write",
          "file-service.objects.write",
        ],
      });
      const described = await createTestBucket(owner, { description: "b" });
      const created: string[] = [described.name];
      for (let i = 0; i < 2; i++) {
        const name = `test-bucket-${generateUniqueId()}`;
        const res = await axios.post(
          `${BASE_URL}/buckets`,
          { name, policy: "private" },
          { headers: { Authorization: `Bearer ${owner}` } }
        );
        expect(res.data.description ?? null).toBeNull();
        created.push(name);
      }
      await uploadTestObject(
        owner,
        described.name,
        "x.txt",
        createTestFile("some bytes")
      );

      for (const sort of ["currentUsageBytes", "description"]) {
        for (const sortDir of ["asc", "desc"]) {
          const names = await walk(owner, sort, sortDir);
          expect(names.sort()).toEqual([...created].sort());
        }
      }
    });

    it("leaves an organization's buckets out of an org-less caller's list", async () => {
      const orgOwner = await getTestPrincipalToken({
        organizationId: `bucket-paging-${generateUniqueId()}`,
        permissions: [
          "file-service.buckets.write",
          "file-service.permissions.write",
        ],
      });
      const orgless = randomUUID();
      const orglessToken = await getTestPrincipalToken({
        userId: orgless,
        organizationId: null,
        permissions: ["file-service.buckets.write"],
      });
      const orgBucket = await createTestBucket(orgOwner);
      // The API refuses this grant; one made before the user left the
      // organization still exists, and must not list the bucket.
      await prisma.bucketPermission.create({
        data: {
          bucketId: orgBucket.id,
          userId: orgless,
          canRead: true,
          grantedBy: orgless,
        },
      });
      const own = await createTestBucket(orglessToken);

      const names = await walk(orglessToken, "createdAt", "desc");
      expect(names).toContain(own.name);
      expect(names).not.toContain(orgBucket.name);
    });
  });

  describe("GET /buckets/:name", () => {
    it("should get bucket details by name", async () => {
      const bucket = await createTestBucket(testToken);

      const response = await axios.get<BucketResponse>(
        `${BASE_URL}/buckets/${bucket.name}`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      const data = response.data;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.id).toBe(bucket.id);
      expect(data.name).toBe(bucket.name);
      expect(data.policy).toBe(bucket.policy);
      const row = await prisma.bucket.findUniqueOrThrow({
        where: { id: bucket.id },
      });
      expect(data.organizationId).toBe(row.organizationId);
    });

    it("should return 404 for non-existent bucket", async () => {
      const response = await axios.get(
        `${BASE_URL}/buckets/non-existent-bucket`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("should return 401 without authentication", async () => {
      const bucket = await createTestBucket(testToken);

      const response = await axios.get(`${BASE_URL}/buckets/${bucket.name}`, {
        validateStatus: () => true,
      });

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });
  });

  describe("PUT /buckets/:name", () => {
    it("should update bucket description", async () => {
      const bucket = await createTestBucket(testToken);
      const newDescription = "Updated description";

      const response = await axios.put<BucketResponse>(
        `${BASE_URL}/buckets/${bucket.name}`,
        { description: newDescription },
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      const data = response.data;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.description).toBe(newDescription);
      expect(data.updatedAt).toBeDefined();
    });

    it("should update bucket policy", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });

      const response = await axios.put<BucketResponse>(
        `${BASE_URL}/buckets/${bucket.name}`,
        { policy: "public" },
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      const data = response.data;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.policy).toBe("public");
    });

    it("should update storage quota", async () => {
      const bucket = await createTestBucket(testToken);
      const newQuota = "2147483648"; // 2GB

      const response = await axios.put<BucketResponse>(
        `${BASE_URL}/buckets/${bucket.name}`,
        { storageQuotaBytes: newQuota },
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      const data = response.data;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.storageQuotaBytes).toBe(newQuota);
    });

    it("clears the storage quota with null", async () => {
      const bucket = await createTestBucket(testToken);
      const put = (body: Record<string, unknown>) =>
        axios.put<BucketResponse>(`${BASE_URL}/buckets/${bucket.name}`, body, {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });

      const set = await put({ storageQuotaBytes: "1073741824" });
      expect(set.status).toBe(HTTP_STATUS.OK);
      expect(set.data.storageQuotaBytes).toBe("1073741824");

      const cleared = await put({ storageQuotaBytes: null });
      expect(cleared.status).toBe(HTTP_STATUS.OK);
      expect(cleared.data.storageQuotaBytes).toBeUndefined();
    });

    it("answers the per-bucket rate limit like the general limiter", async () => {
      const bucket = await createTestBucket(testToken);
      const headers = { Authorization: `Bearer ${testToken}` };
      const set = await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        { rateLimitConfig: { tokensPerSecond: 0.01, maxTokens: 1 } },
        { headers, validateStatus: () => true }
      );
      expect(set.status).toBe(HTTP_STATUS.OK);

      const list = () =>
        axios.get(`${BASE_URL}/buckets/${bucket.name}/objects`, {
          headers,
          validateStatus: () => true,
        });
      expect((await list()).status).toBe(HTTP_STATUS.OK);

      const limited = await list();
      expect(limited.status).toBe(429);
      expect(limited.data).toMatchObject({
        error: "too_many_requests",
        retry_after: expect.any(Number),
      });
      expect(limited.data.retry_after).toBeGreaterThanOrEqual(1);
      expect(limited.headers["retry-after"]).toBe(
        String(limited.data.retry_after)
      );
      expect(limited.headers["x-ratelimit-limit"]).toBe("1");
      expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
      expect(
        Date.parse(limited.headers["x-ratelimit-reset"] as string)
      ).toBeGreaterThan(Date.now());
    });

    it("sets and clears corsConfig and rateLimitConfig", async () => {
      const bucket = await createTestBucket(testToken);
      const put = (body: Record<string, unknown>) =>
        axios.put<BucketResponse>(`${BASE_URL}/buckets/${bucket.name}`, body, {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });

      const set = await put({
        corsConfig: { allowedOrigins: ["https://example.com"] },
        rateLimitConfig: { tokensPerSecond: 5, maxTokens: 10 },
      });
      expect(set.status).toBe(HTTP_STATUS.OK);
      expect(set.data.corsConfig).toMatchObject({
        allowedOrigins: ["https://example.com"],
      });
      expect(set.data.rateLimitConfig).toMatchObject({ maxTokens: 10 });

      const cleared = await put({ corsConfig: null, rateLimitConfig: null });
      expect(cleared.status).toBe(HTTP_STATUS.OK);
      expect(cleared.data.corsConfig).toBeNull();
      expect(cleared.data.rateLimitConfig).toBeNull();
    });

    it("should return 404 for non-existent bucket", async () => {
      const response = await axios.put(
        `${BASE_URL}/buckets/non-existent-bucket`,
        { description: "Updated" },
        {
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });
  });

  describe("DELETE /buckets/:name", () => {
    it("should delete a bucket", async () => {
      const bucket = await createTestBucket(testToken);

      const response = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);

      // Verify bucket is deleted
      const getResponse = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(getResponse.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("frees the name for a new bucket", async () => {
      const bucket = await createTestBucket(testToken);
      const auth = {
        headers: { Authorization: `Bearer ${testToken}` },
        validateStatus: () => true,
      };
      await uploadTestObject(
        testToken,
        bucket.name,
        "old.txt",
        createTestFile("old", "old.txt", "text/plain")
      );
      const deleted = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}`,
        auth
      );
      expect(deleted.status).toBe(HTTP_STATUS.NO_CONTENT);

      const again = await createTestBucket(testToken, { name: bucket.name });
      expect(again.id).not.toBe(bucket.id);

      const fetched = await axios.get<BucketResponse>(
        `${BASE_URL}/buckets/${bucket.name}`,
        auth
      );
      expect(fetched.status).toBe(HTTP_STATUS.OK);
      expect(fetched.data.id).toBe(again.id);
      const old = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/old.txt`,
        auth
      );
      expect(old.status).toBe(HTTP_STATUS.NOT_FOUND);

      const duplicate = await axios.post(
        `${BASE_URL}/buckets`,
        { name: bucket.name, policy: "private" },
        auth
      );
      expect(duplicate.status).toBe(HTTP_STATUS.CONFLICT);
    });

    it("should return 404 for non-existent bucket", async () => {
      const response = await axios.delete(
        `${BASE_URL}/buckets/non-existent-bucket`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("should return 401 without authentication", async () => {
      const bucket = await createTestBucket(testToken);

      const response = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}`,
        { validateStatus: () => true }
      );

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });
  });

  describe("bucket races and limits", () => {
    const auth = () => ({
      headers: { Authorization: `Bearer ${testToken}` },
      validateStatus: () => true,
    });

    it("refuses a rate limit whose requestCost exceeds maxTokens", async () => {
      const bucket = await createTestBucket(testToken);
      const res = await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        {
          rateLimitConfig: { tokensPerSecond: 1, maxTokens: 2, requestCost: 3 },
        },
        auth()
      );
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
      const equal = await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        {
          rateLimitConfig: { tokensPerSecond: 1, maxTokens: 2, requestCost: 2 },
        },
        auth()
      );
      expect(equal.status).toBe(HTTP_STATUS.OK);
    });

    it("deletes once when two deletes race: one audit entry, the other 404", async () => {
      const bucket = await createTestBucket(testToken);
      const statuses = (
        await Promise.all(
          [0, 1, 2].map(() =>
            axios.delete(`${BASE_URL}/buckets/${bucket.name}`, auth())
          )
        )
      )
        .map((r) => r.status)
        .sort();
      expect(statuses).toEqual([
        HTTP_STATUS.NO_CONTENT,
        HTTP_STATUS.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND,
      ]);
      const entries = await prisma.auditLogEntry.count({
        where: {
          entityType: "bucket",
          entityId: String(bucket.id),
          action: "DELETE",
        },
      });
      expect(entries).toBe(1);
    });

    it("does not update a bucket deleted since it was read", async () => {
      const bucket = await createTestBucket(testToken);
      await prisma.bucket.update({
        where: { id: bucket.id },
        data: { deletedAt: new Date() },
      });
      await expect(
        db.buckets.update(bucket.id, { description: "after delete" })
      ).rejects.toMatchObject({ statusCode: 404 });
      const row = await prisma.bucket.findUniqueOrThrow({
        where: { id: bucket.id },
      });
      expect(row.description).not.toBe("after delete");
    });
  });
});
