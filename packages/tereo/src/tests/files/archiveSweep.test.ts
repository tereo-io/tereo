import { processArchiveSweepTick } from "../../jobs/archiveSweep.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomBytes } from "crypto";
import env from "../../env.js";
import {
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  getTestUserId,
  uploadTestObjectAndGetId,
} from "../support/files.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("archiveSweep worker", () => {
  let token: string;
  let bucketId: number;
  let versionId: string;

  beforeAll(async () => {
    token = await getTestAccessToken();
    const bucket = await createTestBucket(token);
    bucketId = bucket.id;
    const objectId = await uploadTestObjectAndGetId(
      token,
      bucket.name,
      "archived.txt",
      createTestFile("archived")
    );
    versionId = (
      await prisma.objectVersion.findFirstOrThrow({
        where: { objectId, isCurrent: true },
      })
    ).id;
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  const createArchive = (expiresAt: Date) =>
    prisma.archiveRequest.create({
      data: {
        bucketId,
        format: "zip",
        filename: "archive.zip",
        objectCount: 1,
        totalSizeBytes: BigInt(8),
        expiresAt,
        objects: { create: [{ position: 0, versionId }] },
      },
    });

  it("deletes archives expired past the retention grace, with their shares and snapshot", async () => {
    const graceMs = env.FILE_SERVICE_SHARE_RETENTION_DAYS * DAY_MS;
    const lapsed = await createArchive(new Date(Date.now() - graceMs - DAY_MS));
    const recentlyExpired = await createArchive(new Date(Date.now() - 60_000));
    const live = await createArchive(new Date(Date.now() + DAY_MS));
    const share = await prisma.share.create({
      data: {
        token: randomBytes(18).toString("base64url"),
        bucketId,
        kind: "ARCHIVE",
        archiveRequestId: lapsed.id,
        createdByUserId: getTestUserId(),
      },
    });

    const result = await processArchiveSweepTick();
    expect(result.processed).toBeGreaterThanOrEqual(1);

    const remaining = await prisma.archiveRequest.findMany({
      where: { id: { in: [lapsed.id, recentlyExpired.id, live.id] } },
      select: { id: true },
    });
    expect(remaining.map((r) => r.id).sort()).toEqual(
      [recentlyExpired.id, live.id].sort()
    );
    expect(
      await prisma.share.findUnique({ where: { id: share.id } })
    ).toBeNull();
    expect(
      await prisma.archiveRequestObject.count({
        where: { archiveRequestId: lapsed.id },
      })
    ).toBe(0);
  });

  it("revokes a share still live before the delete, and audits the sweep", async () => {
    const graceMs = env.FILE_SERVICE_SHARE_RETENTION_DAYS * DAY_MS;
    const lapsed = await createArchive(new Date(Date.now() - graceMs - DAY_MS));
    const share = (expiresAt: Date | null, revokedAt: Date | null = null) =>
      prisma.share.create({
        data: {
          token: randomBytes(18).toString("base64url"),
          bucketId,
          kind: "ARCHIVE",
          archiveRequestId: lapsed.id,
          expiresAt,
          revokedAt,
          createdByUserId: getTestUserId(),
        },
      });
    const live = await share(new Date(Date.now() + DAY_MS));
    const expired = await share(new Date(Date.now() - DAY_MS));
    const revoked = await share(null, new Date());

    await processArchiveSweepTick();

    const revocations = await prisma.auditLogEntry.findMany({
      where: {
        entityType: "share",
        action: "DELETE",
        entityId: { in: [live.id, expired.id, revoked.id] },
      },
    });
    expect(revocations.map((e) => e.entityId)).toEqual([live.id]);
    expect(revocations[0].userId).toBe(SYSTEM_USER_ID);
    expect(revocations[0].metadata).toMatchObject({
      reason: "archive_expired",
      kind: "ARCHIVE",
    });

    const sweeps = await prisma.auditLogEntry.findMany({
      where: { entityType: "archiveSweep", entityId: String(bucketId) },
    });
    const entry = sweeps.find((e) =>
      JSON.stringify(e.metadata).includes(lapsed.id)
    );
    expect(entry?.action).toBe("DELETE");
    const archives = (
      entry?.metadata as { archives: { id: string; shareIds: string[] }[] }
    ).archives;
    expect(archives.find((a) => a.id === lapsed.id)?.shareIds.sort()).toEqual(
      [live.id, expired.id, revoked.id].sort()
    );
  });
});
