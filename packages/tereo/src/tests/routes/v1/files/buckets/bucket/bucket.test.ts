// @module-tag int
// @module-tag files
// @module-tag race
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import axios from "axios";
import {
  FIXTURE_ORGANIZATION_IDS,
  getTestPrincipalToken,
} from "../../../../../support/principals.js";
import {
  cleanupTestEntities as cleanupWebhookEntities,
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../../support/webhooks.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObject,
} from "../../../../../support/files.js";

describe("GET, PUT and DELETE /v1/files/buckets/:name", () => {
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
    let testToken: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
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
          axios.put<BucketResponse>(
            `${BASE_URL}/buckets/${bucket.name}`,
            body,
            {
              headers: { Authorization: `Bearer ${testToken}` },
              validateStatus: () => true,
            }
          );

        const set = await put({ storageQuotaBytes: "1073741824" });
        expect(set.status).toBe(HTTP_STATUS.OK);
        expect(set.data.storageQuotaBytes).toBe("1073741824");

        const cleared = await put({ storageQuotaBytes: null });
        expect(cleared.status).toBe(HTTP_STATUS.OK);
        expect(cleared.data.storageQuotaBytes).toBeUndefined();
      });

      it("sets and clears corsConfig and rateLimitConfig", async () => {
        const bucket = await createTestBucket(testToken);
        const put = (body: Record<string, unknown>) =>
          axios.put<BucketResponse>(
            `${BASE_URL}/buckets/${bucket.name}`,
            body,
            {
              headers: { Authorization: `Bearer ${testToken}` },
              validateStatus: () => true,
            }
          );

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
            rateLimitConfig: {
              tokensPerSecond: 1,
              maxTokens: 2,
              requestCost: 3,
            },
          },
          auth()
        );
        expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
        const equal = await axios.put(
          `${BASE_URL}/buckets/${bucket.name}`,
          {
            rateLimitConfig: {
              tokensPerSecond: 1,
              maxTokens: 2,
              requestCost: 2,
            },
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

    const auth = () => ({ Authorization: `Bearer ${token}` });

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

    it("emits bucket.updated only when an update changes something", async () => {
      const bucket = await createTestBucket(token);
      const put = (body: Record<string, unknown>) =>
        axios.put(`${BASE_URL}/buckets/${bucket.name}`, body, {
          headers: auth(),
        });

      // Unchanged: no audit entry, and no event.
      await put({ versioningEnabled: false, policy: "private" });
      await put({ description: "changed" });

      const [payload] = await delivered(
        "file-service.bucket.updated",
        String(bucket.id)
      );
      expect(payload).toMatchObject({ data: { bucketName: bucket.name } });
      const outboxed = await prisma.webhookDelivery.count({
        where: {
          webhookEndpointId: endpointId,
          eventType: "file-service.bucket.updated",
          payload: { path: ["entityId"], equals: String(bucket.id) },
        },
      });
      expect(outboxed).toBe(1);
      expect(
        await prisma.auditLogEntry.count({
          where: {
            entityType: "bucket",
            entityId: String(bucket.id),
            action: "UPDATE",
          },
        })
      ).toBe(1);
    });

    it("diffs a bucket update against the row it locked", async () => {
      const bucket = await createTestBucket(token);
      const put = (description: string) =>
        axios.put(
          `${BASE_URL}/buckets/${bucket.name}`,
          { description },
          { headers: auth() }
        );
      const responses = await Promise.all([put("first"), put("second")]);
      expect(responses.map((r) => r.status)).toEqual([200, 200]);

      const entries = await prisma.auditLogEntry.findMany({
        where: {
          entityType: "bucket",
          entityId: String(bucket.id),
          action: "UPDATE",
        },
        orderBy: { createdAt: "asc" },
      });
      const diffs = entries.map(
        (e) =>
          (e.changes as { description: { old: unknown; new: unknown } })
            .description
      );
      expect(diffs).toHaveLength(2);
      // The update that took the lock second saw the first one's value.
      const [a, b] = diffs;
      expect(a.old === b.new || b.old === a.new).toBe(true);
    });
  });
});
