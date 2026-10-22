// @module-tag int
// @module-tag files
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  FIXTURE_ORGANIZATION_IDS,
  getTestPrincipalToken,
} from "../../../../support/principals.js";
import {
  cleanupTestEntities as cleanupWebhookEntities,
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../support/webhooks.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  generateUniqueId,
  getTestAccessToken,
  uploadTestObject,
} from "../../../../support/files.js";

describe("GET and POST /v1/files/buckets", () => {
  describe("Bucket Management", () => {
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
        const response = await axios.post<ErrorResponse>(
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
        expect(response.data.error).toBe("invalid_request");
        expect(response.data.error_description).toEqual(expect.any(String));
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
  });

  describe("file-service webhook events", () => {
    const ORG_ID = FIXTURE_ORGANIZATION_IDS[0];

    const EVENT_TYPES = [
      "file-service.bucket.created",
      "file-service.bucket.updated",
      "file-service.bucket.owner-changed",
      "file-service.object.created",
      "file-service.object.updated",
      "file-service.object.version.created",
      "file-service.permission.granted",
      "file-service.permission.revoked",
      "file-service.multipart.completed",
      "file-service.multipart.aborted",
      "file-service.lifecycle.policy.updated",
      "file-service.lifecycle.policy.deleted",
    ];
    let token: string;
    let endpointId: string;

    // Waits for the fan-out of one event to the test endpoint and returns the
    // delivered payload.
    const delivered = async (eventType: string, entityId: string) => {
      const where = {
        webhookEndpointId: endpointId,
        eventType,
        payload: { path: ["entityId"], equals: entityId },
      };
      await waitFor(
        async () => (await prisma.webhookDelivery.count({ where })) > 0,
        10_000
      );
      const deliveries = await prisma.webhookDelivery.findMany({ where });
      return deliveries.map((d) => d.payload as Record<string, unknown>);
    };

    beforeAll(async () => {
      token = await getTestPrincipalToken({
        organizationId: ORG_ID,
        permissions: ["file-service.admin"],
      });
      const endpoint = await createTestWebhookEndpoint(
        await getCoreEventSubscriberToken(ORG_ID),
        { eventTypes: EVENT_TYPES }
      );
      endpointId = endpoint.id;
    });

    afterAll(async () => {
      await cleanupTestEntities();
      await cleanupWebhookEntities();
    });

    it("emits bucket.created", async () => {
      const bucket = await createTestBucket(token);

      const [payload] = await delivered(
        "file-service.bucket.created",
        String(bucket.id)
      );
      expect(payload).toMatchObject({
        organizationId: ORG_ID,
        entityType: "bucket",
        data: {
          bucketName: bucket.name,
          policy: "private",
          versioningEnabled: false,
        },
      });
    });

    it("emits permission.granted for the creator's grant on bucket.create", async () => {
      const bucket = await createTestBucket(token);
      const grant = await prisma.bucketPermission.findFirstOrThrow({
        where: { bucketId: bucket.id, userId: bucket.createdBy },
      });

      const [payload] = await delivered(
        "file-service.permission.granted",
        String(grant.id)
      );
      expect(payload).toMatchObject({
        organizationId: ORG_ID,
        entityType: "bucketPermission",
        data: {
          bucketName: bucket.name,
          userId: bucket.createdBy,
          canRead: true,
          canWrite: true,
          canDelete: true,
          grantedBy: bucket.createdBy,
        },
      });
    });
  });
});
