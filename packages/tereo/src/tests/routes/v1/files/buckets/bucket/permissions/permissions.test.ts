// @module-tag int
// @module-tag files
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  FIXTURE_ORGANIZATION_IDS,
  FIXTURE_USER_IDS,
  ensureTestMembership,
  ensureTestUser,
  getTestPrincipalToken,
} from "../../../../../../support/principals.js";
import {
  cleanupTestEntities as cleanupWebhookEntities,
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../../../support/webhooks.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  getTestAccessToken,
  getTestUserId,
  grantTestPermission,
} from "../../../../../../support/files.js";

describe("GET and POST /v1/files/buckets/:name/permissions", () => {
  describe("Bucket Permissions", () => {
    interface PermissionResponse {
      id: number;
      userId: string;
      canRead: boolean;
      canWrite: boolean;
      canDelete: boolean;
      grantedAt: string;
      grantedBy: string;
    }

    interface PermissionsListResponse {
      data: PermissionResponse[];
      total: number;
      hasMore: boolean;
    }

    interface ErrorResponse {
      error?: string;
      error_description?: string;
    }
    let testToken: string;
    let testUserId: string;
    let testBucket: { id: number; name: string; policy: string };

    beforeAll(async () => {
      testToken = await getTestAccessToken();
      testUserId = getTestUserId();
      testBucket = await createTestBucket(testToken);
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("POST /buckets/:name/permissions", () => {
      it("should grant read permission to user", async () => {
        const targetUserId = "00000000-0000-7001-0000-000000000002";

        const response = await axios.post<PermissionResponse>(
          `${BASE_URL}/buckets/${testBucket.name}/permissions`,
          {
            userId: targetUserId,
            canRead: true,
            canWrite: false,
            canDelete: false,
          },
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
        expect(data.userId).toBe(targetUserId);
        expect(data.canRead).toBe(true);
        expect(data.canWrite).toBe(false);
        expect(data.canDelete).toBe(false);
        expect(data.grantedAt).toBeDefined();
        expect(data.grantedBy).toBe(testUserId);
      });

      it("should grant write permission to user", async () => {
        const targetUserId = "00000000-0000-7001-0000-000000000003";

        const response = await axios.post<PermissionResponse>(
          `${BASE_URL}/buckets/${testBucket.name}/permissions`,
          {
            userId: targetUserId,
            canRead: true,
            canWrite: true,
            canDelete: false,
          },
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
        expect(data.canWrite).toBe(true);
      });

      it("should grant all permissions to user", async () => {
        const targetUserId = "00000000-0000-7001-0000-000000000004";

        const response = await axios.post<PermissionResponse>(
          `${BASE_URL}/buckets/${testBucket.name}/permissions`,
          {
            userId: targetUserId,
            canRead: true,
            canWrite: true,
            canDelete: true,
          },
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
        expect(data.canRead).toBe(true);
        expect(data.canWrite).toBe(true);
        expect(data.canDelete).toBe(true);
      });

      it("should return 409 for duplicate permission", async () => {
        const targetUserId = "00000000-0000-7001-0000-000000000005";

        // Grant permission first time
        await grantTestPermission(testToken, testBucket.name, targetUserId, {
          canRead: true,
        });

        // Try to grant again
        const response = await axios.post<ErrorResponse>(
          `${BASE_URL}/buckets/${testBucket.name}/permissions`,
          {
            userId: targetUserId,
            canRead: true,
            canWrite: false,
            canDelete: false,
          },
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

      it("is 400 unknown_user for a userId that names no user", async () => {
        const response = await axios.post<ErrorResponse>(
          `${BASE_URL}/buckets/${testBucket.name}/permissions`,
          { userId: randomUUID(), canRead: true },
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(response.data.error).toBe("unknown_user");
      });

      it("should return 404 for non-existent bucket", async () => {
        const response = await axios.post(
          `${BASE_URL}/buckets/non-existent/permissions`,
          {
            userId: "00000000-0000-7001-0000-000000000002",
            canRead: true,
            canWrite: false,
            canDelete: false,
          },
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

    describe("GET /buckets/:name/permissions", () => {
      it("should list all bucket permissions", async () => {
        const response = await axios.get<PermissionsListResponse>(
          `${BASE_URL}/buckets/${testBucket.name}/permissions`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        const data = response.data;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.data).toBeDefined();
        expect(Array.isArray(data.data)).toBe(true);

        // The creator's own grant is always there.
        expect(data.data.length).toBeGreaterThan(0);
        const permission = data.data[0];
        expect(permission.id).toBeDefined();
        expect(permission.userId).toBeDefined();
        expect(typeof permission.canRead).toBe("boolean");
        expect(typeof permission.canWrite).toBe("boolean");
        expect(typeof permission.canDelete).toBe("boolean");
        expect(permission.grantedAt).toBeDefined();
        expect(permission.grantedBy).toBeDefined();
      });

      it("filters by userId, and refuses one that is not a UUID", async () => {
        const userId = await ensureTestUser(randomUUID());
        await grantTestPermission(testToken, testBucket.name, userId, {
          canRead: true,
        });
        const url = `${BASE_URL}/buckets/${testBucket.name}/permissions`;
        const auth = { headers: { Authorization: `Bearer ${testToken}` } };

        const one = await axios.get<PermissionsListResponse>(
          `${url}?filter[userId]=${userId}`,
          auth
        );
        expect(one.data.data.map((p) => p.userId)).toEqual([userId]);

        const bad = await axios.get(`${url}?filter[userId]=123`, {
          ...auth,
          validateStatus: () => true,
        });
        expect(bad.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(bad.data.error).toBe("invalid_request");
        expect(bad.data.error_description).toEqual(expect.any(String));
      });

      it("filters by canRead/canWrite/canDelete, including false", async () => {
        const bucket = await createTestBucket(testToken);
        const reader = await ensureTestUser(randomUUID());
        const writer = await ensureTestUser(randomUUID());
        await grantTestPermission(testToken, bucket.name, reader, {
          canRead: true,
        });
        await grantTestPermission(testToken, bucket.name, writer, {
          canRead: true,
          canWrite: true,
        });

        const list = async (query: string) => {
          const response = await axios.get<PermissionsListResponse>(
            `${BASE_URL}/buckets/${bucket.name}/permissions?${query}`,
            { headers: { Authorization: `Bearer ${testToken}` } }
          );
          return response.data.data.map((p) => p.userId);
        };

        const notWriters = await list("filter[canWrite]=false");
        expect(notWriters).toContain(reader);
        expect(notWriters).not.toContain(writer);

        const writers = await list("filter[canWrite]=true");
        expect(writers).toContain(writer);
        expect(writers).not.toContain(reader);

        const deleters = await list("filter[canDelete]=true");
        expect(deleters).not.toContain(reader);
        expect(deleters).not.toContain(writer);
      });

      it("should return 404 for non-existent bucket", async () => {
        const response = await axios.get(
          `${BASE_URL}/buckets/non-existent/permissions`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      });
    });
  });

  describe("Bucket access", () => {
    // Everything a bucket creator does here, but no `file-service.admin`: object
    // access has to come from the creator's grant.
    const MEMBER = [
      "file-service.buckets.delete",
      "file-service.objects.delete",
      "file-service.permissions.delete",
      "file-service.shares.delete",
    ];

    const ORG = "bucket-access-org";

    const as = (token?: string) => ({
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      validateStatus: () => true,
    });
    let creatorId: string;
    let creatorToken: string;

    beforeAll(async () => {
      creatorId = randomUUID();
      creatorToken = await getTestPrincipalToken({
        userId: creatorId,
        organizationId: ORG,
        permissions: MEMBER,
      });
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("grant user ids", () => {
      it("are validated as UUIDs", async () => {
        const bucket = await createTestBucket(creatorToken);
        const url = `${BASE_URL}/buckets/${bucket.name}/permissions`;

        const grant = await axios.post(
          url,
          { userId: "not-a-uuid", canRead: true },
          as(creatorToken)
        );
        expect(grant.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(grant.data.error).toBe("invalid_request");
        expect(grant.data.error_description).toEqual(expect.any(String));

        // Any hex UUID is a user id, RFC variant or not.
        await ensureTestMembership(FIXTURE_USER_IDS[2], ORG);
        const fixture = await axios.post(
          url,
          { userId: FIXTURE_USER_IDS[2], canRead: true },
          as(creatorToken)
        );
        expect(fixture.status).toBe(HTTP_STATUS.CREATED);
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

    it("emits permission.granted and permission.revoked", async () => {
      const bucket = await createTestBucket(token);
      const userId = randomUUID();
      await ensureTestMembership(userId, ORG_ID);

      const grant = await grantTestPermission(token, bucket.name, userId, {
        canRead: true,
        canWrite: true,
      });
      const [granted] = await delivered(
        "file-service.permission.granted",
        String(grant.id)
      );
      expect(granted).toMatchObject({
        entityType: "bucketPermission",
        data: {
          bucketName: bucket.name,
          userId,
          canRead: true,
          canWrite: true,
          canDelete: false,
        },
      });

      const revoke = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/permissions/${userId}`,
        { headers: auth() }
      );
      expect(revoke.status).toBe(HTTP_STATUS.NO_CONTENT);
      const [revoked] = await delivered(
        "file-service.permission.revoked",
        String(grant.id)
      );
      expect(revoked).toMatchObject({
        data: { bucketName: bucket.name, userId },
      });

      const again = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/permissions/${userId}`,
        { headers: auth(), validateStatus: () => true }
      );
      expect(again.status).toBe(HTTP_STATUS.NOT_FOUND);
    });
  });

  describe("files integrity", { tags: ["race"] }, () => {
    let token: string;
    const auth = () => ({
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    it("grants and revokes once under concurrent requests", async () => {
      const bucket = await createTestBucket(token);
      const userId = await ensureTestUser(randomUUID());
      await grantTestPermission(token, bucket.name, userId, { canRead: true });

      const revokeUrl = `${BASE_URL}/buckets/${bucket.name}/permissions/${userId}`;
      const revokes = await Promise.all([
        axios.delete(revokeUrl, auth()),
        axios.delete(revokeUrl, auth()),
      ]);
      expect(revokes.map((r) => r.status).sort()).toEqual([
        HTTP_STATUS.NO_CONTENT,
        HTTP_STATUS.NOT_FOUND,
      ]);

      const grant = () =>
        axios.post(
          `${BASE_URL}/buckets/${bucket.name}/permissions`,
          { userId, canRead: true, canWrite: false, canDelete: false },
          auth()
        );
      const grants = await Promise.all([grant(), grant()]);
      expect(grants.map((r) => r.status).sort()).toEqual([
        HTTP_STATUS.CREATED,
        HTTP_STATUS.CONFLICT,
      ]);
    });
  });
});
