// @module-tag int
// @module-tag files
// @module-tag job
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomBytes } from "node:crypto";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  processShareSweepTick,
  SHARE_SWEEP_BATCH_LIMIT,
} from "../../jobs/shareSweep.js";
import {
  ensureTestMembership,
  getTestPrincipalToken,
  testOrgId,
} from "../support/principals.js";
import {
  BASE_URL,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  HTTP_STATUS,
  uploadTestObject,
  uploadTestObjectAndGetId,
} from "../support/files.js";

describe("processShareSweepTick", () => {
  describe("Shares", () => {
    interface ShareResponse {
      id: string;
      token: string;
      bucketId: number;
      kind: "OBJECT" | "ARCHIVE";
      url: string;
      urlFilename: string | null;
      objectId: string | null;
      versionId: string | null;
      archiveRequestId: string | null;
      hasPassword: boolean;
      expiresAt: string | null;
      maxDownloads: number | null;
      downloadCount: number;
      revokedAt: string | null;
      status: "active" | "revoked" | "expired" | "exhausted";
      object: { id: string; objectKey: string } | null;
      archiveRequest: { filename: string } | null;
    }
    let token: string;
    let bucket: { id: number; name: string };
    let objectId: string;

    beforeAll(async () => {
      token = await getTestAccessToken();
      bucket = await createTestBucket(token, { policy: "private" });
      objectId = await uploadTestObjectAndGetId(
        token,
        bucket.name,
        "report.pdf",
        createTestFile("pdf-bytes", "report.pdf", "application/pdf")
      );
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("Expiry", () => {
      const MAX_MS = 365 * 24 * 60 * 60 * 1000;
      const create = async () => {
        const res = await axios.post<ShareResponse>(
          `${BASE_URL}/buckets/${bucket.name}/shares`,
          { kind: "OBJECT", objectId },
          { headers: { Authorization: `Bearer ${token}` } }
        );
        expect(res.status).toBe(HTTP_STATUS.CREATED);
        return res.data;
      };

      it("fills in an expiry for a share that has none, from its creation", async () => {
        const share = await create();
        // Past the cap, but not yet past the retention grace.
        const createdAt = new Date(Date.now() - 370 * 24 * 60 * 60 * 1000);
        await prisma.share.update({
          where: { id: share.id },
          data: { expiresAt: null, createdAt },
        });

        await processShareSweepTick();

        const row = await prisma.share.findUniqueOrThrow({
          where: { id: share.id },
        });
        expect(row.expiresAt?.getTime()).toBe(createdAt.getTime() + MAX_MS);
        const backfills = await prisma.auditLogEntry.findMany({
          where: {
            entityType: "shareExpiryBackfill",
            entityId: String(bucket.id),
          },
        });
        const entry = backfills.find((e) =>
          JSON.stringify(e.metadata).includes(share.id)
        );
        expect(entry).toMatchObject({
          action: "UPDATE",
          userId: SYSTEM_USER_ID,
        });
        const res = await axios.get(share.url, {
          maxRedirects: 0,
          validateStatus: () => true,
        });
        expect(res.status).toBe(HTTP_STATUS.NOT_FOUND);
      });

      it("fills at most a batch per tick, and asks for another when it filled one", async () => {
        const share = await create();
        const createdAt = new Date(Date.now() - 370 * 24 * 60 * 60 * 1000);
        const row = await prisma.share.update({
          where: { id: share.id },
          data: { expiresAt: null, createdAt },
        });
        const { id: _id, token: _token, updatedAt: _updatedAt, ...copy } = row;
        await prisma.share.createMany({
          data: Array.from({ length: SHARE_SWEEP_BATCH_LIMIT }, () => ({
            ...copy,
            token: randomBytes(24).toString("base64url"),
          })),
        });
        const ours = { bucketId: bucket.id, createdAt, expiresAt: null };
        const since = new Date();

        const first = await processShareSweepTick();
        expect(first.hasMore).toBe(true);
        const left = await prisma.share.count({ where: ours });
        expect(left).toBeGreaterThanOrEqual(1);

        for (
          let i = 0;
          i < 5 && (await prisma.share.count({ where: ours }));
          i++
        ) {
          await processShareSweepTick();
        }
        expect(await prisma.share.count({ where: ours })).toBe(0);

        const entries = await prisma.auditLogEntry.findMany({
          where: {
            entityType: "shareExpiryBackfill",
            entityId: String(bucket.id),
            createdAt: { gte: since },
          },
        });
        expect(entries.length).toBeGreaterThanOrEqual(2);
        for (const entry of entries) {
          const { shares } = entry.metadata as { shares: unknown[] };
          expect(shares.length).toBeLessThanOrEqual(SHARE_SWEEP_BATCH_LIMIT);
        }
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

    afterAll(async () => {
      await cleanupTestEntities();
    });

    it("audits the share sweep's deletes, as the system user", async () => {
      const owner = await member();
      const bucket = await createTestBucket(owner.token);
      const object = await uploadTestObject(
        owner.token,
        bucket.name,
        "doc.txt",
        createTestFile("doc")
      );
      const share = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        { kind: "OBJECT", objectId: object.id },
        as(owner.token)
      );
      await prisma.share.update({
        where: { id: share.data.id },
        data: { revokedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) },
      });

      await processShareSweepTick();

      expect(
        await prisma.share.findUnique({ where: { id: share.data.id } })
      ).toBeNull();
      const entry = await prisma.auditLogEntry.findFirstOrThrow({
        where: { entityType: "shareSweep", entityId: String(bucket.id) },
      });
      expect(entry).toMatchObject({
        action: "DELETE",
        userId: SYSTEM_USER_ID,
        organizationId: testOrgId(ORG),
      });
      expect(entry.metadata).toMatchObject({
        bucketName: bucket.name,
        processed: 1,
        shares: [{ id: share.data.id, kind: "OBJECT" }],
      });
    });
  });
});
