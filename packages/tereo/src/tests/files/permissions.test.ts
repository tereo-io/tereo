import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  getTestUserId,
  createTestBucket,
  grantTestPermission,
  cleanupTestEntities,
  createTestFile,
  uploadTestObject,
} from "./utils/test-helpers.js";
import {
  ensureTestMembership,
  ensureTestUser,
  getTestPrincipalToken,
} from "../utils/principals.js";

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

describe("Bucket Permissions", () => {
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

    it("should return 401 without authentication", async () => {
      const response = await axios.post(
        `${BASE_URL}/buckets/${testBucket.name}/permissions`,
        {
          userId: "00000000-0000-7001-0000-000000000999",
          canRead: true,
          canWrite: false,
          canDelete: false,
        },
        {
          headers: { "Content-Type": "application/json" },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
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

    it("should return 400 for invalid user ID", async () => {
      const response = await axios.post(
        `${BASE_URL}/buckets/${testBucket.name}/permissions`,
        {
          userId: "",
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

      expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
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

    it("should return 401 without authentication", async () => {
      const response = await axios.get(
        `${BASE_URL}/buckets/${testBucket.name}/permissions`,
        {
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
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

  describe("DELETE /buckets/:name/permissions/:userId", () => {
    it("should revoke user permission", async () => {
      const targetUserId = "00000000-0000-7001-0000-000000000006";

      // Grant permission first
      await grantTestPermission(testToken, testBucket.name, targetUserId, {
        canRead: true,
      });

      // Revoke permission
      const response = await axios.delete(
        `${BASE_URL}/buckets/${testBucket.name}/permissions/${targetUserId}`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);

      // Verify permission is revoked by checking list
      const listResponse = await axios.get<PermissionsListResponse>(
        `${BASE_URL}/buckets/${testBucket.name}/permissions`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      const listData = listResponse.data;
      const hasPermission = listData.data.some(
        (p) => p.userId === targetUserId
      );
      expect(hasPermission).toBe(false);
    });

    it("should return 404 for non-existent permission", async () => {
      const response = await axios.delete(
        `${BASE_URL}/buckets/${testBucket.name}/permissions/00000000-0000-7001-0000-000000099999`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("should return 401 without authentication", async () => {
      const response = await axios.delete(
        `${BASE_URL}/buckets/${testBucket.name}/permissions/00000000-0000-7001-0000-000000000002`,
        {
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it("should return 404 for non-existent bucket", async () => {
      const response = await axios.delete(
        `${BASE_URL}/buckets/non-existent/permissions/00000000-0000-7001-0000-000000000002`,
        {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        }
      );

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    });
  });

  describe("Permission-based access control", () => {
    const ORG = "permissions-acl-org";
    const ROLE = ["file-service.objects.delete", "file-service.buckets.delete"];
    let bucketName: string;
    let objectId: string;
    let readerToken: string;

    beforeAll(async () => {
      const creator = await getTestPrincipalToken({
        organizationId: ORG,
        permissions: [...ROLE, "file-service.permissions.write"],
      });
      bucketName = (await createTestBucket(creator)).name;
      objectId = (
        await uploadTestObject(
          creator,
          bucketName,
          "doc.txt",
          createTestFile("granted")
        )
      ).id;
      const readerId = randomUUID();
      readerToken = await getTestPrincipalToken({
        userId: readerId,
        organizationId: ORG,
        permissions: ROLE,
      });
      await ensureTestMembership(readerId, ORG);
      await grantTestPermission(creator, bucketName, readerId, {
        canRead: true,
      });
    });

    it("should allow user with read permission to download objects", async () => {
      const res = await axios.get(
        `${BASE_URL}/buckets/${bucketName}/objects/doc.txt`,
        { headers: { Authorization: `Bearer ${readerToken}` } }
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.data).toBe("granted");
    });

    it("should deny user without write permission from uploading", async () => {
      await expect(
        uploadTestObject(
          readerToken,
          bucketName,
          "other.txt",
          createTestFile("nope")
        )
      ).rejects.toThrow(/Failed to upload test object: 403/);
    });

    it("should deny user without delete permission from deleting objects", async () => {
      const res = await axios.delete(
        `${BASE_URL}/buckets/${bucketName}/objects/by-id/${objectId}`,
        {
          headers: { Authorization: `Bearer ${readerToken}` },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    });
  });
});
