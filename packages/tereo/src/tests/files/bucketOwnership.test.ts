import { FIXTURE_USER_IDS, ensureTestUser } from "../utils/principals.js";
import { TEST_SERVICE, TEST_SERVICE_ID } from "../utils/testService.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestPrincipalToken } from "../utils/principals.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  generateUniqueId,
  getTestAccessToken,
} from "./utils/test-helpers.js";

const MANAGER = [
  "file-service.buckets.delete",
  "file-service.permissions.delete",
];

const as = (token: string) => ({
  headers: { Authorization: `Bearer ${token}` },
  validateStatus: () => true,
});

describe("Bucket ownership", () => {
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
