// @module-tag int
// @module-tag files
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { CORE_URL } from "../../support/coreUrl.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  ensureTestMembership,
  getTestPrincipalToken,
  testOrgId,
} from "../../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  uploadTestObject,
  bucketOwnerAccess,
} from "../../support/files.js";

describe("an organization member's removal", () => {
  describe("Bucket ownership and active grants", () => {
    // Everything a bucket owner does, but no `file-service.admin`.
    const { ORG, as, member, grant } = bucketOwnerAccess;

    afterAll(async () => {
      await cleanupTestEntities();
    });

    it("revokes a removed member's grants on the organization's buckets", async () => {
      const owner = await member();
      const leaving = await member();
      const bucket = await createTestBucket(owner.token);
      await grant(owner.token, bucket.name, leaving.userId, {
        canRead: true,
        canWrite: true,
      });
      const orgAdmin = await getTestPrincipalToken({ permissions: ["admin"] });

      const res = await axios.delete(
        `${CORE_URL}/v1/admin/organizations/${testOrgId(ORG)}/members/${leaving.userId}`,
        as(orgAdmin)
      );
      expect(res.status).toBe(HTTP_STATUS.NO_CONTENT);

      const row = await prisma.bucketPermission.findUniqueOrThrow({
        where: {
          bucketId_userId: { bucketId: bucket.id, userId: leaving.userId },
        },
      });
      expect(row.revokedAt).not.toBeNull();
      const entry = await prisma.auditLogEntry.findFirstOrThrow({
        where: {
          entityType: "bucketPermission",
          entityId: String(row.id),
          action: "DELETE",
        },
      });
      expect(entry.metadata).toMatchObject({
        targetUserId: leaving.userId,
        reason: "organization_member_removed",
      });

      // The owner's grant stays.
      const kept = await prisma.bucketPermission.findUniqueOrThrow({
        where: {
          bucketId_userId: { bucketId: bucket.id, userId: owner.userId },
        },
      });
      expect(kept.revokedAt).toBeNull();
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

    describe("DELETE /admin/organizations/:id/members/:userId?revokeShares", () => {
      const remove = (userId: string, query = "") =>
        getTestPrincipalToken({ permissions: ["admin"] }).then((token) =>
          axios.delete(
            `${CORE_URL}/v1/admin/organizations/${testOrgId(ORG)}/members/${userId}${query}`,
            as(token)
          )
        );

      it("leaves a removed member's shares serving by default", async () => {
        const { creator, share } = await setup();
        const s = await share();
        expect((await remove(creator.userId)).status).toBe(
          HTTP_STATUS.NO_CONTENT
        );
        expect((await shareRow(s.id)).revokedAt).toBeNull();
      });

      it("revokes them on the organization's buckets with revokeShares=true", async () => {
        const { creator, share } = await setup();
        const s = await share();
        expect(
          (await remove(creator.userId, "?revokeShares=true")).status
        ).toBe(HTTP_STATUS.NO_CONTENT);
        expect((await shareRow(s.id)).revokedAt).not.toBeNull();
        const entry = await prisma.auditLogEntry.findFirstOrThrow({
          where: { entityType: "share", entityId: s.id, action: "DELETE" },
        });
        expect(entry.metadata).toMatchObject({
          reason: "organization_member_removed",
        });
      });
    });
  });
});
