// @module-tag int
// @module-tag files
// @module-tag security
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  ensureTestMembership,
  ensureTestUser,
  getTestPrincipalToken,
  testOrgId,
} from "../../../../../../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  generateUniqueId,
  getTestAccessToken,
  grantTestPermission,
} from "../../../../../../support/files.js";

describe("POST /v1/files/buckets/:name/permissions", () => {
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
    const OTHER_ORG = "bucket-access-other-org";

    const as = (token?: string) => ({
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      validateStatus: () => true,
    });

    // A grant in an organization's bucket goes to a member of it.
    const grantInOrg = async (
      token: string,
      bucketName: string,
      userId: string,
      flags: { canRead?: boolean; canWrite?: boolean; canDelete?: boolean }
    ) => {
      await ensureTestMembership(userId, ORG);
      return await grantTestPermission(token, bucketName, userId, flags);
    };
    let adminToken: string;
    let creatorId: string;
    let creatorToken: string;

    beforeAll(async () => {
      adminToken = await getTestAccessToken();
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

    describe("grants in an organization's bucket", () => {
      const post = (token: string, bucketName: string, userId: string) =>
        axios.post(
          `${BASE_URL}/buckets/${bucketName}/permissions`,
          { userId, canRead: true },
          as(token)
        );

      it("refuse a user outside the organization, writing nothing", async () => {
        const bucket = await createTestBucket(creatorToken);
        const outsiderId = randomUUID();
        await ensureTestMembership(outsiderId, OTHER_ORG);

        const res = await post(creatorToken, bucket.name, outsiderId);
        expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(res.data.error).toBe("user_not_in_organization");

        expect(
          await prisma.bucketPermission.count({
            where: { bucketId: bucket.id, userId: outsiderId },
          })
        ).toBe(0);
        expect(
          await prisma.auditLogEntry.count({
            where: {
              entityType: "bucketPermission",
              entityName: `${bucket.name}:${outsiderId}`,
            },
          })
        ).toBe(0);
      });

      it("refuse a user in no organization, even for an admin", async () => {
        const bucket = await createTestBucket(creatorToken);
        const loneId = await ensureTestUser(randomUUID());

        for (const token of [creatorToken, adminToken]) {
          const res = await post(token, bucket.name, loneId);
          expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
          expect(res.data.error).toBe("user_not_in_organization");
        }
      });

      it("refuse renewing a revoked grant once the user has left", async () => {
        const bucket = await createTestBucket(creatorToken);
        const userId = randomUUID();
        await grantInOrg(creatorToken, bucket.name, userId, { canRead: true });
        const revoke = await axios.delete(
          `${BASE_URL}/buckets/${bucket.name}/permissions/${userId}`,
          as(creatorToken)
        );
        expect(revoke.status).toBe(HTTP_STATUS.NO_CONTENT);
        await prisma.organizationMember.delete({
          where: {
            organizationId_userId: { organizationId: testOrgId(ORG), userId },
          },
        });

        const res = await post(creatorToken, bucket.name, userId);
        expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(res.data.error).toBe("user_not_in_organization");
        const row = await prisma.bucketPermission.findFirstOrThrow({
          where: { bucketId: bucket.id, userId },
        });
        expect(row.revokedAt).not.toBeNull();
      });

      it("accept the service-account user of a client bound to the organization", async () => {
        const bucket = await createTestBucket(creatorToken);
        const client = await prisma.oAuthClient.create({
          data: {
            clientId: `test-grant-client-${generateUniqueId()}`,
            name: "Grant test client",
            redirectUris: [],
            scopes: [],
            grantTypes: ["client_credentials"],
            ownerId: creatorId,
            organizationId: testOrgId(ORG),
          },
        });
        const serviceUserId = randomUUID();
        await prisma.user.create({
          data: {
            id: serviceUserId,
            email: `test-user-${serviceUserId}@example.com`,
            passwordHash: "!",
            userType: "service_account",
            oauthClientId: client.id,
          },
        });

        const res = await post(creatorToken, bucket.name, serviceUserId);
        expect(res.status).toBe(HTTP_STATUS.CREATED);
      });

      it("accept any user on a bucket in no organization", async () => {
        const orgless = await getTestPrincipalToken({
          organizationId: null,
          permissions: MEMBER,
        });
        const bucket = await createTestBucket(orgless);
        const loneId = await ensureTestUser(randomUUID());

        const res = await post(orgless, bucket.name, loneId);
        expect(res.status).toBe(HTTP_STATUS.CREATED);
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
    let adminToken: string;

    beforeAll(async () => {
      adminToken = await getTestPrincipalToken({
        organizationId: ORG,
        permissions: ["file-service.admin"],
      });
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("POST /permissions", () => {
      it("gives no flag beyond the granter's own grant", async () => {
        const owner = await member();
        const bucket = await createTestBucket(owner.token);
        await prisma.bucketPermission.update({
          where: {
            bucketId_userId: { bucketId: bucket.id, userId: owner.userId },
          },
          data: { canDelete: false },
        });
        const target = await member();

        const beyond = await grant(owner.token, bucket.name, target.userId, {
          canRead: true,
          canDelete: true,
        });
        expect(beyond.status).toBe(HTTP_STATUS.FORBIDDEN);
        expect(beyond.data.error_description).toContain("canDelete");

        const within = await grant(owner.token, bucket.name, target.userId, {
          canRead: true,
          canWrite: true,
        });
        expect(within.status).toBe(HTTP_STATUS.CREATED);
      });

      it("lets file-service.admin give any flag without a grant of its own", async () => {
        const owner = await member();
        const bucket = await createTestBucket(owner.token);
        const target = await member();
        const res = await grant(adminToken, bucket.name, target.userId, {
          canRead: true,
          canWrite: true,
          canDelete: true,
        });
        expect(res.status).toBe(HTTP_STATUS.CREATED);
      });
    });
  });
});
