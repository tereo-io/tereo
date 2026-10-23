// @module-tag int
// @module-tag files
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  ensureTestMembership,
  getTestPrincipalToken,
} from "../../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  grantTestPermission,
  uploadTestObject,
} from "../../support/files.js";

describe("bucket grants", () => {
  describe("Bucket Permissions", () => {
    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("Permission-based access control", () => {
      const ORG = "permissions-acl-org";
      const ROLE = [
        "file-service.objects.delete",
        "file-service.buckets.delete",
      ];
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

    const member = (organizationId: string | null = ORG) =>
      getTestPrincipalToken({
        userId: randomUUID(),
        organizationId,
        permissions: MEMBER,
      });
    let creatorId: string;
    let creatorToken: string;
    let outsiderToken: string;

    beforeAll(async () => {
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

    describe("the creator's grant", () => {
      it("is created with the bucket, listed, and audited", async () => {
        const bucket = await createTestBucket(creatorToken);

        const list = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/permissions`,
          as(creatorToken)
        );
        expect(list.status).toBe(HTTP_STATUS.OK);
        expect(list.data.data).toHaveLength(1);
        expect(list.data.data[0]).toMatchObject({
          userId: creatorId,
          canRead: true,
          canWrite: true,
          canDelete: true,
          grantedBy: creatorId,
        });

        const entry = await prisma.auditLogEntry.findFirst({
          where: {
            entityType: "bucketPermission",
            entityId: String(list.data.data[0].id),
          },
        });
        expect(entry).toMatchObject({ action: "CREATE", userId: creatorId });
      });

      it("lets a non-admin creator upload, read and delete", async () => {
        const bucket = await createTestBucket(creatorToken);
        const object = await uploadTestObject(
          creatorToken,
          bucket.name,
          "doc.txt",
          createTestFile("hello")
        );

        const read = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/doc.txt`,
          as(creatorToken)
        );
        expect(read.status).toBe(HTTP_STATUS.OK);
        expect(read.data).toBe("hello");

        const del = await axios.delete(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${object.id}`,
          as(creatorToken)
        );
        expect(del.status).toBe(HTTP_STATUS.NO_CONTENT);
      });

      it("gives no access to a non-creator in the same organization", async () => {
        const bucket = await createTestBucket(creatorToken);
        await uploadTestObject(
          creatorToken,
          bucket.name,
          "doc.txt",
          createTestFile("hello")
        );

        const read = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/doc.txt`,
          as(outsiderToken)
        );
        expect(read.status).toBe(HTTP_STATUS.FORBIDDEN);
        const list = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects`,
          as(outsiderToken)
        );
        expect(list.status).toBe(HTTP_STATUS.FORBIDDEN);
      });

      it("is revocable, and revoking it removes the creator's object access", async () => {
        const bucket = await createTestBucket(creatorToken);
        await uploadTestObject(
          creatorToken,
          bucket.name,
          "doc.txt",
          createTestFile("hello")
        );

        const revoke = await axios.delete(
          `${BASE_URL}/buckets/${bucket.name}/permissions/${creatorId}`,
          as(creatorToken)
        );
        expect(revoke.status).toBe(HTTP_STATUS.NO_CONTENT);

        const read = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/doc.txt`,
          as(creatorToken)
        );
        expect(read.status).toBe(HTTP_STATUS.FORBIDDEN);

        const mine = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/my-permissions`,
          as(creatorToken)
        );
        expect(mine.status).toBe(HTTP_STATUS.FORBIDDEN);
      });
    });
  });
});
