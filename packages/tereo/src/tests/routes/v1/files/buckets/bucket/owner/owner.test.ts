// @module-tag int
// @module-tag files
import { TEST_SERVICE_ID } from "../../../../../../support/testService.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  FIXTURE_ORGANIZATION_IDS,
  ensureTestMembership,
  ensureTestUser,
  getTestPrincipalToken,
} from "../../../../../../support/principals.js";
import {
  cleanupTestEntities as cleanupWebhookEntities,
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
} from "../../../../../../support/webhooks.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  generateUniqueId,
  getTestAccessToken,
  uploadTestObject,
  bucketOwnerAccess,
  deliveredPayloads,
} from "../../../../../../support/files.js";

describe("PUT /v1/files/buckets/:name/owner", () => {
  describe("Bucket ownership and active grants", () => {
    // Everything a bucket owner does, but no `file-service.admin`.
    const { ORG, as, member, grant } = bucketOwnerAccess;

    const revoke = (token: string, bucketName: string, userId: string) =>
      axios.delete(
        `${BASE_URL}/buckets/${bucketName}/permissions/${userId}`,
        as(token)
      );

    const transfer = (token: string, bucketName: string, userId: string) =>
      axios.put(
        `${BASE_URL}/buckets/${bucketName}/owner`,
        { userId },
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

    describe("PUT /buckets/:name/owner", () => {
      it("is for file-service.admin only", async () => {
        const owner = await member();
        const other = await member();
        const bucket = await createTestBucket(owner.token);

        const res = await transfer(owner.token, bucket.name, other.userId);
        expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
        const row = await prisma.bucket.findUniqueOrThrow({
          where: { id: bucket.id },
        });
        expect(row.ownerId).toBe(owner.userId);
      });

      it("hands management to the new owner, with a full grant", async () => {
        const owner = await member();
        const next = await member();
        const bucket = await createTestBucket(owner.token);
        await uploadTestObject(
          owner.token,
          bucket.name,
          "doc.txt",
          createTestFile("hello")
        );

        const res = await transfer(adminToken, bucket.name, next.userId);
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(res.data).toMatchObject({
          ownerId: next.userId,
          owner: { id: next.userId },
          createdBy: owner.userId,
        });

        const nextGrant = await prisma.bucketPermission.findUniqueOrThrow({
          where: {
            bucketId_userId: { bucketId: bucket.id, userId: next.userId },
          },
        });
        expect(nextGrant).toMatchObject({
          canRead: true,
          canWrite: true,
          canDelete: true,
          revokedAt: null,
        });
        expect(await manage(next.token, bucket.name)).toEqual({
          read: HTTP_STATUS.OK,
          update: HTTP_STATUS.OK,
          lifecycle: HTTP_STATUS.OK,
          permissions: HTTP_STATUS.OK,
        });
        expect(await listNames(next.token, bucket.name)).toEqual([bucket.name]);

        // The old owner keeps the grant's object access, not the management.
        const old = await manage(owner.token, bucket.name);
        expect(old.update).toBe(HTTP_STATUS.FORBIDDEN);
        expect(old.lifecycle).toBe(HTTP_STATUS.FORBIDDEN);
        const read = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/doc.txt`,
          as(owner.token)
        );
        expect(read.status).toBe(HTTP_STATUS.OK);
        await uploadTestObject(
          owner.token,
          bucket.name,
          "more.txt",
          createTestFile("more")
        );

        const entries = await prisma.auditLogEntry.findMany({
          where: {
            entityType: "bucket",
            entityId: String(bucket.id),
            action: "UPDATE",
          },
        });
        expect(
          entries.filter((e) => e.changes && "ownerId" in (e.changes as object))
        ).toMatchObject([
          { changes: { ownerId: { old: owner.userId, new: next.userId } } },
        ]);
      });

      it("revives a new owner's revoked grant, and keeps an active one as it is", async () => {
        const owner = await member();
        const reader = await member();
        const bucket = await createTestBucket(owner.token);
        await grant(owner.token, bucket.name, reader.userId, { canRead: true });

        expect(
          (await transfer(adminToken, bucket.name, reader.userId)).status
        ).toBe(HTTP_STATUS.OK);
        const kept = await prisma.bucketPermission.findUniqueOrThrow({
          where: {
            bucketId_userId: { bucketId: bucket.id, userId: reader.userId },
          },
        });
        expect(kept).toMatchObject({ canRead: true, canWrite: false });

        await revoke(adminToken, bucket.name, owner.userId);
        expect(
          (await transfer(adminToken, bucket.name, owner.userId)).status
        ).toBe(HTTP_STATUS.OK);
        const revived = await prisma.bucketPermission.findUniqueOrThrow({
          where: {
            bucketId_userId: { bucketId: bucket.id, userId: owner.userId },
          },
        });
        expect(revived).toMatchObject({
          canRead: true,
          canWrite: true,
          canDelete: true,
          revokedAt: null,
        });
      });

      it("refuses a user outside the bucket's organization, or none", async () => {
        const owner = await member();
        const bucket = await createTestBucket(owner.token);
        const outsider = await ensureTestUser(randomUUID());

        const res = await transfer(adminToken, bucket.name, outsider);
        expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(res.data.error).toBe("user_not_in_organization");

        const unknown = await transfer(adminToken, bucket.name, randomUUID());
        expect(unknown.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(unknown.data.error).toBe("unknown_user");
      });

      it("refuses a deactivated user", async () => {
        const owner = await member();
        const next = await member();
        const bucket = await createTestBucket(owner.token);
        await prisma.user.update({
          where: { id: next.userId },
          data: { isActive: false },
        });

        const res = await transfer(adminToken, bucket.name, next.userId);
        expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(res.data.error).toBe("user_inactive");
      });

      it("refuses a declared bucket", async () => {
        const serviceUserId = await ensureTestUser(randomUUID());
        const declared = await prisma.bucket.create({
          data: {
            name: `test-bucket-${generateUniqueId()}`,
            policy: "private",
            serviceId: TEST_SERVICE_ID,
            createdBy: serviceUserId,
            ownerId: serviceUserId,
          },
        });
        try {
          const next = await ensureTestUser(randomUUID());
          const res = await transfer(
            await getTestAccessToken(),
            declared.name,
            next
          );
          expect(res.status).toBe(HTTP_STATUS.CONFLICT);
          expect(res.data.error).toBe("bucket_declared");
        } finally {
          await prisma.bucket.delete({ where: { id: declared.id } });
        }
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
    const delivered = (eventType: string, entityId: string) =>
      deliveredPayloads(endpointId, eventType, entityId);

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

    it("emits bucket.owner-changed on a transfer", async () => {
      const bucket = await createTestBucket(token);
      const next = randomUUID();
      await ensureTestMembership(next, ORG_ID);

      const res = await axios.put(
        `${BASE_URL}/buckets/${bucket.name}/owner`,
        { userId: next },
        { headers: auth() }
      );
      expect(res.status).toBe(HTTP_STATUS.OK);

      const [payload] = await delivered(
        "file-service.bucket.owner-changed",
        String(bucket.id)
      );
      expect(payload).toMatchObject({
        organizationId: ORG_ID,
        entityType: "bucket",
        data: {
          bucketName: bucket.name,
          ownerId: next,
          previousOwnerId: bucket.createdBy,
        },
      });
    });
  });
});
