// @module-tag int
// @module-tag files
// @module-tag security
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  ensureTestMembership,
  getTestPrincipalToken,
} from "../../../../../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  generateUniqueId,
  getTestAccessToken,
  grantTestPermission,
} from "../../../../../support/files.js";

describe("GET /v1/files/buckets/:name and /v1/files/buckets/:name/my-permissions", () => {
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

    const member = (organizationId: string | null = ORG) =>
      getTestPrincipalToken({
        userId: randomUUID(),
        organizationId,
        permissions: MEMBER,
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
    let outsiderToken: string;

    beforeAll(async () => {
      adminToken = await getTestAccessToken();
      creatorId = randomUUID();
      creatorToken = await getTestPrincipalToken({
        userId: creatorId,
        organizationId: ORG,
        permissions: MEMBER,
      });
      outsiderToken = await member();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("GET /buckets/:name/my-permissions", () => {
      it("reports the creator's grant", async () => {
        const bucket = await createTestBucket(creatorToken);
        const res = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/my-permissions`,
          as(creatorToken)
        );
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(res.data).toStrictEqual({
          canRead: true,
          canWrite: true,
          canDelete: true,
        });
      });

      it("is 403 without a grant on a private bucket, as for a missing one", async () => {
        const bucket = await createTestBucket(creatorToken);
        const res = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/my-permissions`,
          as(outsiderToken)
        );
        expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      });

      it("reports a partial grant flag by flag", async () => {
        const bucket = await createTestBucket(creatorToken);
        const userId = randomUUID();
        const token = await getTestPrincipalToken({
          userId,
          organizationId: ORG,
          permissions: MEMBER,
        });
        await grantInOrg(creatorToken, bucket.name, userId, {
          canRead: true,
        });
        const res = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/my-permissions`,
          as(token)
        );
        expect(res.data).toStrictEqual({
          canRead: true,
          canWrite: false,
          canDelete: false,
        });
      });

      it("reports only what the caller's role permissions allow of the grant", async () => {
        const bucket = await createTestBucket(creatorToken);
        const userId = randomUUID();
        const token = await getTestPrincipalToken({
          userId,
          organizationId: ORG,
          permissions: ["file-service.objects.read"],
        });
        await grantInOrg(creatorToken, bucket.name, userId, {
          canRead: true,
          canWrite: true,
          canDelete: true,
        });
        const res = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/my-permissions`,
          as(token)
        );
        expect(res.data).toStrictEqual({
          canRead: true,
          canWrite: false,
          canDelete: false,
        });

        // As the object routes answer it.
        const upload = await axios.put(
          `${BASE_URL}/buckets/${bucket.name}/objects/denied.txt`,
          undefined,
          as(token)
        );
        expect(upload.status).toBe(HTTP_STATUS.FORBIDDEN);
      });

      it("reports no write access to a retired bucket, for the creator or an admin", async () => {
        const bucket = await createTestBucket(creatorToken);
        await prisma.bucket.update({
          where: { id: bucket.id },
          data: { retiredAt: new Date() },
        });

        const mine = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/my-permissions`,
          as(creatorToken)
        );
        expect(mine.data).toStrictEqual({
          canRead: true,
          canWrite: false,
          canDelete: true,
        });
        const admin = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/my-permissions`,
          as(adminToken)
        );
        expect(admin.data).toStrictEqual({
          canRead: true,
          canWrite: false,
          canDelete: true,
        });
      });

      it("is 403 for another organization's bucket, and for a missing one", async () => {
        const bucket = await createTestBucket(creatorToken);
        const otherOrg = await member(OTHER_ORG);

        const other = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/my-permissions`,
          as(otherOrg)
        );
        expect(other.status).toBe(HTTP_STATUS.FORBIDDEN);

        const missing = await axios.get(
          `${BASE_URL}/buckets/test-bucket-${generateUniqueId()}/my-permissions`,
          as(otherOrg)
        );
        expect(missing.status).toBe(HTTP_STATUS.FORBIDDEN);
        expect(missing.data).toEqual(other.data);

        const asAdmin = await axios.get(
          `${BASE_URL}/buckets/test-bucket-${generateUniqueId()}/my-permissions`,
          as(adminToken)
        );
        expect(asAdmin.status).toBe(HTTP_STATUS.NOT_FOUND);
      });
    });

    describe("missing and inaccessible buckets", () => {
      it("answer a caller without access identically", async () => {
        const bucket = await createTestBucket(creatorToken);
        const missing = `test-bucket-${generateUniqueId()}`;
        const suffixes = [
          "",
          "/permissions",
          "/lifecycle",
          "/objects",
          "/shares",
          `/objects/by-id/${randomUUID()}/versions`,
        ];

        for (const suffix of suffixes) {
          for (const name of [bucket.name, missing]) {
            const path = `/buckets/${name}${suffix}`;
            const res = await axios.get(
              `${BASE_URL}${path}`,
              as(outsiderToken)
            );
            expect([path, res.status]).toEqual([path, HTTP_STATUS.FORBIDDEN]);
          }
        }
      });

      it("refuse settings reads with a token for another organization", async () => {
        const bucket = await createTestBucket(creatorToken);
        const granteeId = randomUUID();
        await getTestPrincipalToken({
          userId: granteeId,
          organizationId: ORG,
          permissions: MEMBER,
        });
        await grantInOrg(creatorToken, bucket.name, granteeId, {
          canRead: true,
        });
        const elsewhere = [creatorId, granteeId].map((userId) =>
          getTestPrincipalToken({
            userId,
            organizationId: OTHER_ORG,
            permissions: MEMBER,
          })
        );

        for (const token of await Promise.all(elsewhere)) {
          for (const suffix of ["", "/permissions", "/lifecycle"]) {
            const path = `/buckets/${bucket.name}${suffix}`;
            const res = await axios.get(`${BASE_URL}${path}`, as(token));
            expect([path, res.status]).toEqual([path, HTTP_STATUS.FORBIDDEN]);
          }
        }
      });

      it("are still 404 for an admin", async () => {
        const res = await axios.get(
          `${BASE_URL}/buckets/test-bucket-${generateUniqueId()}`,
          as(adminToken)
        );
        expect(res.status).toBe(HTTP_STATUS.NOT_FOUND);
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

    describe("GET /my-permissions", () => {
      it("is the same 403 as a missing bucket without a grant on a private one", async () => {
        const owner = await member();
        const outsider = await member();
        const bucket = await createTestBucket(owner.token);
        const mine = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/my-permissions`,
          as(outsider.token)
        );
        const missing = await axios.get(
          `${BASE_URL}/buckets/no-such-${randomUUID()}/my-permissions`,
          as(outsider.token)
        );
        expect(mine.status).toBe(HTTP_STATUS.FORBIDDEN);
        expect(mine.data).toEqual(missing.data);
      });

      it("reports read access to a public bucket without a grant", async () => {
        const owner = await member();
        const outsider = await member();
        const bucket = await createTestBucket(owner.token);
        const toPublic = await axios.put(
          `${BASE_URL}/buckets/${bucket.name}`,
          { policy: "public" },
          as(adminToken)
        );
        expect(toPublic.status).toBe(HTTP_STATUS.OK);
        const res = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/my-permissions`,
          as(outsider.token)
        );
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(res.data).toStrictEqual({
          canRead: true,
          canWrite: false,
          canDelete: false,
        });
      });
    });
  });
});
