// @module-tag int
// @module-tag files
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  ensureTestMembership,
  getTestPrincipalToken,
  testOrgId,
} from "../../../../../../../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  grantTestPermission,
  uploadTestObject,
} from "../../../../../../../support/files.js";

describe("DELETE /v1/files/buckets/:name/permissions/:userId", () => {
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
    let testToken: string;
    let testBucket: { id: number; name: string; policy: string };

    beforeAll(async () => {
      testToken = await getTestAccessToken();
      testBucket = await createTestBucket(testToken);
    });

    afterAll(async () => {
      await cleanupTestEntities();
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
  });

  describe("Share links and the access of whoever made them", () => {
    // Everything a bucket owner does, but no `file-service.admin`.
    const MEMBER = [
      "file-service.buckets.delete",
      "file-service.objects.delete",
      "file-service.permissions.delete",
      "file-service.shares.delete",
    ];

    const ORG = "share-creator-access-org";

    const as = (token?: string) => ({
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      validateStatus: () => true,
    });

    const member = async (permissions = MEMBER) => {
      const userId = randomUUID();
      await ensureTestMembership(userId, ORG);
      const token = await getTestPrincipalToken({
        userId,
        organizationId: ORG,
        permissions,
      });
      return { userId, token };
    };

    type Flags = { canRead?: boolean; canWrite?: boolean; canDelete?: boolean };

    const grant = (
      token: string,
      bucketName: string,
      userId: string,
      f: Flags
    ) =>
      axios.post(
        `${BASE_URL}/buckets/${bucketName}/permissions`,
        {
          userId,
          canRead: f.canRead ?? false,
          canWrite: f.canWrite ?? false,
          canDelete: f.canDelete ?? false,
        },
        as(token)
      );

    /** A bucket its owner made, with one object and a reader who shares it. */
    const setup = async () => {
      const owner = await member();
      const creator = await member();
      const bucket = await createTestBucket(owner.token);
      const object = await uploadTestObject(
        owner.token,
        bucket.name,
        "doc.txt",
        createTestFile("doc")
      );
      expect(
        (
          await grant(owner.token, bucket.name, creator.userId, {
            canRead: true,
          })
        ).status
      ).toBe(HTTP_STATUS.CREATED);
      const share = async (body: Record<string, unknown> = {}) => {
        const res = await axios.post(
          `${BASE_URL}/buckets/${bucket.name}/shares`,
          { kind: "OBJECT", objectId: object.id, ...body },
          as(creator.token)
        );
        expect(res.status).toBe(HTTP_STATUS.CREATED);
        return res.data as { id: string; token: string; url: string };
      };
      return { owner, creator, bucket, share };
    };

    const shareRow = (id: string) =>
      prisma.share.findUniqueOrThrow({ where: { id } });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("DELETE /permissions/:userId?revokeShares", () => {
      it("leaves the user's shares serving by default", async () => {
        const { owner, creator, bucket, share } = await setup();
        const s = await share();

        const res = await axios.delete(
          `${BASE_URL}/buckets/${bucket.name}/permissions/${creator.userId}`,
          as(owner.token)
        );
        expect(res.status).toBe(HTTP_STATUS.NO_CONTENT);

        expect((await shareRow(s.id)).revokedAt).toBeNull();
        const download = await axios.get(s.url, {
          maxRedirects: 0,
          validateStatus: () => true,
        });
        expect(download.status).toBe(302);
      });

      it("revokes and audits the user's live shares on that bucket with revokeShares=true", async () => {
        const { owner, creator, bucket, share } = await setup();
        const mine = await share();
        const expired = await share();
        await prisma.share.update({
          where: { id: expired.id },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
        const ownersShare = await axios.post(
          `${BASE_URL}/buckets/${bucket.name}/shares`,
          {
            kind: "OBJECT",
            objectId: (await shareRow(mine.id)).objectId,
          },
          as(owner.token)
        );

        const res = await axios.delete(
          `${BASE_URL}/buckets/${bucket.name}/permissions/${creator.userId}?revokeShares=true`,
          as(owner.token)
        );
        expect(res.status).toBe(HTTP_STATUS.NO_CONTENT);

        const revoked = await shareRow(mine.id);
        expect(revoked.revokedAt).not.toBeNull();
        expect(revoked.revokedByUserId).toBe(owner.userId);
        expect((await shareRow(expired.id)).revokedAt).toBeNull();
        expect((await shareRow(ownersShare.data.id)).revokedAt).toBeNull();

        const entry = await prisma.auditLogEntry.findFirstOrThrow({
          where: { entityType: "share", entityId: mine.id, action: "DELETE" },
        });
        expect(entry).toMatchObject({
          userId: owner.userId,
          organizationId: testOrgId(ORG),
        });
        expect(entry.metadata).toMatchObject({
          bucketName: bucket.name,
          reason: "permission_revoked",
        });
      });

      it("refuses a revokeShares that isn't true or false", async () => {
        const { owner, creator, bucket } = await setup();
        const res = await axios.delete(
          `${BASE_URL}/buckets/${bucket.name}/permissions/${creator.userId}?revokeShares=yes`,
          as(owner.token)
        );
        expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });
    });
  });
});
