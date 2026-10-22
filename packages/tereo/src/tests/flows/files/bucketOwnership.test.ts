// @module-tag int
// @module-tag files
// @module-tag security
import { TEST_SERVICE, TEST_SERVICE_ID } from "../../support/testService.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_USER_ID } from "../../../definitions/index.js";
import { prisma } from "../../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  FIXTURE_USER_IDS,
  ensureTestMembership,
  ensureTestUser,
  getTestPrincipalToken,
} from "../../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  generateUniqueId,
  getTestAccessToken,
} from "../../support/files.js";

describe("bucket ownership", () => {
  describe("Bucket ownership", () => {
    const MANAGER = [
      "file-service.buckets.delete",
      "file-service.permissions.delete",
    ];

    const as = (token: string) => ({
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });
    const declaredName = `test-bucket-${generateUniqueId()}`;
    const serviceUserId = randomUUID();
    let declaredId: number;
    let adminToken: string;
    let serviceToken: string;
    let outsiderToken: string;

    beforeAll(async () => {
      adminToken = await getTestAccessToken();
      await ensureTestUser(serviceUserId);
      serviceToken = await getTestPrincipalToken({
        userId: serviceUserId,
        permissions: MANAGER,
      });
      outsiderToken = await getTestPrincipalToken({ permissions: MANAGER });

      // What the registry makes for a declared bucket, under the test service.
      const bucket = await prisma.bucket.create({
        data: {
          name: declaredName,
          description: "Declared",
          policy: "private",
          serviceId: TEST_SERVICE_ID,
          createdBy: serviceUserId,
          ownerId: serviceUserId,
        },
      });
      declaredId = bucket.id;
      await prisma.bucketPermission.create({
        data: {
          bucketId: bucket.id,
          userId: serviceUserId,
          canRead: true,
          canWrite: true,
          canDelete: true,
          grantedBy: SYSTEM_USER_ID,
        },
      });
    });

    afterAll(async () => {
      await prisma.bucketPermission
        .deleteMany({ where: { bucketId: declaredId } })
        .catch(() => {});
      await prisma.bucket.delete({ where: { id: declaredId } }).catch(() => {});
      await cleanupTestEntities();
    });

    describe("a declared bucket", () => {
      const url = `${BASE_URL}/buckets/${declaredName}`;

      it("returns its owner and declaring service", async () => {
        const res = await axios.get(url, as(adminToken));
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(res.data).toMatchObject({
          createdBy: serviceUserId,
          ownerId: serviceUserId,
          serviceId: TEST_SERVICE_ID,
          serviceName: TEST_SERVICE.name,
          missingSince: null,
          retiredAt: null,
        });

        const list = await axios.get(
          `${BASE_URL}/buckets?filter[name]=${declaredName}&filter[name_op]=equals`,
          as(adminToken)
        );
        expect(list.data.data[0]).toMatchObject({
          serviceId: TEST_SERVICE_ID,
          serviceName: TEST_SERVICE.name,
        });
      });

      it("lets an admin change quota, CORS, rate limit and policy", async () => {
        const res = await axios.put(
          url,
          {
            description: "Declared",
            policy: "public",
            storageQuotaBytes: "1048576",
            corsConfig: { allowedOrigins: ["https://example.com"] },
            rateLimitConfig: { tokensPerSecond: 5, maxTokens: 10 },
          },
          as(adminToken)
        );
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(res.data).toMatchObject({
          policy: "public",
          storageQuotaBytes: "1048576",
          corsConfig: { allowedOrigins: ["https://example.com"] },
          rateLimitConfig: { tokensPerSecond: 5, maxTokens: 10 },
          serviceName: TEST_SERVICE.name,
        });
      });

      it("lets the bare admin permission manage it too", async () => {
        const token = await getTestPrincipalToken({ permissions: ["admin"] });
        const res = await axios.put(
          url,
          { storageQuotaBytes: "2097152" },
          as(token)
        );
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(res.data.storageQuotaBytes).toBe("2097152");
      });

      it("refuses a changed description, which the declaration re-applies", async () => {
        const res = await axios.put(
          url,
          { description: "Renamed" },
          as(adminToken)
        );
        expect(res.status).toBe(HTTP_STATUS.CONFLICT);
        expect(res.data.error).toBe("bucket_declared");
      });

      it("lets an admin grant and revoke access", async () => {
        const userId = FIXTURE_USER_IDS[1];
        const grant = await axios.post(
          `${url}/permissions`,
          { userId, canRead: true, canWrite: true, canDelete: false },
          as(adminToken)
        );
        expect(grant.status).toBe(HTTP_STATUS.CREATED);

        const revoke = await axios.delete(
          `${url}/permissions/${userId}`,
          as(adminToken)
        );
        expect(revoke.status).toBe(HTTP_STATUS.NO_CONTENT);
      });

      it("refuses revoking the declaring service's own grant", async () => {
        const res = await axios.delete(
          `${url}/permissions/${serviceUserId}`,
          as(adminToken)
        );
        expect(res.status).toBe(HTTP_STATUS.CONFLICT);
        expect(res.data.error).toBe("bucket_declared");
      });

      it("cannot be deleted, by an admin or by its service", async () => {
        for (const token of [adminToken, serviceToken]) {
          const res = await axios.delete(url, as(token));
          expect(res.status).toBe(HTTP_STATUS.CONFLICT);
          expect(res.data.error).toBe("bucket_declared");
        }
        const row = await prisma.bucket.findUniqueOrThrow({
          where: { id: declaredId },
        });
        expect(row.deletedAt).toBeNull();
      });

      it("is 403 for a non-admin who does not own it", async () => {
        expect(
          (await axios.put(url, { storageQuotaBytes: "1" }, as(outsiderToken)))
            .status
        ).toBe(HTTP_STATUS.FORBIDDEN);
        expect((await axios.delete(url, as(outsiderToken))).status).toBe(
          HTTP_STATUS.FORBIDDEN
        );
        expect(
          (
            await axios.post(
              `${url}/permissions`,
              { userId: FIXTURE_USER_IDS[2], canRead: true },
              as(outsiderToken)
            )
          ).status
        ).toBe(HTTP_STATUS.FORBIDDEN);
      });
    });

    describe("a user-created bucket", () => {
      it("returns its creator and no service", async () => {
        const creatorId = randomUUID();
        const token = await getTestPrincipalToken({
          userId: creatorId,
          permissions: MANAGER,
        });
        const bucket = await createTestBucket(token);
        expect(bucket).toMatchObject({
          createdBy: creatorId,
          ownerId: creatorId,
          owner: { id: creatorId },
          serviceId: null,
          serviceName: null,
          missingSince: null,
          retiredAt: null,
        });
      });

      it("can be managed and deleted by an admin who did not create it", async () => {
        const token = await getTestPrincipalToken({ permissions: MANAGER });
        const bucket = await createTestBucket(token);
        const url = `${BASE_URL}/buckets/${bucket.name}`;

        const update = await axios.put(
          url,
          { description: "Tuned by an admin", storageQuotaBytes: "1048576" },
          as(adminToken)
        );
        expect(update.status).toBe(HTTP_STATUS.OK);

        const grant = await axios.post(
          `${url}/permissions`,
          { userId: FIXTURE_USER_IDS[1], canRead: true },
          as(adminToken)
        );
        expect(grant.status).toBe(HTTP_STATUS.CREATED);

        expect((await axios.delete(url, as(adminToken))).status).toBe(
          HTTP_STATUS.NO_CONTENT
        );
      });

      it("is 403 for a non-admin who does not own it", async () => {
        const token = await getTestPrincipalToken({ permissions: MANAGER });
        const bucket = await createTestBucket(token);
        const url = `${BASE_URL}/buckets/${bucket.name}`;

        expect(
          (await axios.put(url, { storageQuotaBytes: "1" }, as(outsiderToken)))
            .status
        ).toBe(HTTP_STATUS.FORBIDDEN);
        expect((await axios.delete(url, as(outsiderToken))).status).toBe(
          HTTP_STATUS.FORBIDDEN
        );
      });
    });
  });

  describe("Bucket ownership and active grants", () => {
    // Everything a bucket owner does, but no `file-service.admin`.
    const MEMBER = [
      "file-service.buckets.delete",
      "file-service.objects.delete",
      "file-service.permissions.delete",
      "file-service.shares.delete",
    ];

    const ORG = "bucket-owner-access-org";

    const as = (token?: string) => ({
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      validateStatus: () => true,
    });

    /** A user in ORG holding MEMBER, and a token for it. */
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

    const grant = (
      token: string,
      bucketName: string,
      userId: string,
      flags: { canRead?: boolean; canWrite?: boolean; canDelete?: boolean }
    ) =>
      axios.post(
        `${BASE_URL}/buckets/${bucketName}/permissions`,
        {
          userId,
          canRead: flags.canRead ?? false,
          canWrite: flags.canWrite ?? false,
          canDelete: flags.canDelete ?? false,
        },
        as(token)
      );

    const revoke = (token: string, bucketName: string, userId: string) =>
      axios.delete(
        `${BASE_URL}/buckets/${bucketName}/permissions/${userId}`,
        as(token)
      );

    const listNames = async (token: string, bucketName: string) => {
      const res = await axios.get(
        `${BASE_URL}/buckets?filter[name]=${bucketName}&filter[name_op]=equals`,
        as(token)
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      return (res.data.data as { name: string }[]).map((b) => b.name);
    };

    /** Status of each management call an owner makes. */
    const manage = async (token: string, bucketName: string) => {
      const url = `${BASE_URL}/buckets/${bucketName}`;
      return {
        read: (await axios.get(url, as(token))).status,
        update: (await axios.put(url, { description: "tuned" }, as(token)))
          .status,
        lifecycle: (
          await axios.put(
            `${url}/lifecycle`,
            { expireObjectsAfterDays: 30 },
            as(token)
          )
        ).status,
        permissions: (await axios.get(`${url}/permissions`, as(token))).status,
      };
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

    describe("an owner whose grant an admin revoked", () => {
      it("manages nothing, can't re-grant themselves, and sees no bucket", async () => {
        const owner = await member();
        const bucket = await createTestBucket(owner.token);
        expect(bucket.ownerId).toBe(owner.userId);
        expect(await manage(owner.token, bucket.name)).toEqual({
          read: HTTP_STATUS.OK,
          update: HTTP_STATUS.OK,
          lifecycle: HTTP_STATUS.OK,
          permissions: HTTP_STATUS.OK,
        });

        expect(
          (await revoke(adminToken, bucket.name, owner.userId)).status
        ).toBe(HTTP_STATUS.NO_CONTENT);

        expect(await manage(owner.token, bucket.name)).toEqual({
          read: HTTP_STATUS.FORBIDDEN,
          update: HTTP_STATUS.FORBIDDEN,
          lifecycle: HTTP_STATUS.FORBIDDEN,
          permissions: HTTP_STATUS.FORBIDDEN,
        });
        expect(
          (
            await grant(owner.token, bucket.name, owner.userId, {
              canRead: true,
              canWrite: true,
              canDelete: true,
            })
          ).status
        ).toBe(HTTP_STATUS.FORBIDDEN);
        const other = await member();
        expect(
          (
            await grant(owner.token, bucket.name, other.userId, {
              canRead: true,
            })
          ).status
        ).toBe(HTTP_STATUS.FORBIDDEN);
        expect(
          (
            await axios.delete(
              `${BASE_URL}/buckets/${bucket.name}`,
              as(owner.token)
            )
          ).status
        ).toBe(HTTP_STATUS.FORBIDDEN);
        expect(await listNames(owner.token, bucket.name)).toEqual([]);
      });

      it("manages again once an admin grants it back", async () => {
        const owner = await member();
        const bucket = await createTestBucket(owner.token);
        await revoke(adminToken, bucket.name, owner.userId);

        expect(
          (
            await grant(adminToken, bucket.name, owner.userId, {
              canRead: true,
            })
          ).status
        ).toBe(HTTP_STATUS.CREATED);

        expect(await manage(owner.token, bucket.name)).toEqual({
          read: HTTP_STATUS.OK,
          update: HTTP_STATUS.OK,
          lifecycle: HTTP_STATUS.OK,
          permissions: HTTP_STATUS.OK,
        });
        expect(await listNames(owner.token, bucket.name)).toEqual([
          bucket.name,
        ]);
      });

      it("can't make their bucket public", async () => {
        const owner = await member();
        const bucket = await createTestBucket(owner.token);
        await revoke(adminToken, bucket.name, owner.userId);

        const res = await axios.put(
          `${BASE_URL}/buckets/${bucket.name}`,
          { policy: "public" },
          as(owner.token)
        );
        expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      });
    });

    it("gives a grant holder who isn't the owner the settings but not their management", async () => {
      const owner = await member();
      const reader = await member();
      const bucket = await createTestBucket(owner.token);
      await grant(owner.token, bucket.name, reader.userId, { canRead: true });

      const status = await manage(reader.token, bucket.name);
      expect(status.read).toBe(HTTP_STATUS.OK);
      expect(status.permissions).toBe(HTTP_STATUS.OK);
      expect(status.update).toBe(HTTP_STATUS.FORBIDDEN);
      expect(status.lifecycle).toBe(HTTP_STATUS.FORBIDDEN);
    });
  });
});
