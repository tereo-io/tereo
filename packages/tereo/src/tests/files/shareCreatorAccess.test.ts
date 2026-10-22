import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { CORE_URL } from "../support/coreUrl.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  ensureTestMembership,
  getTestPrincipalToken,
  testOrgId,
} from "../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  uploadTestObject,
} from "../support/files.js";

// Everything a bucket owner does, but no `file-service.admin`.
const MEMBER = [
  "file-service.buckets.delete",
  "file-service.objects.delete",
  "file-service.permissions.delete",
  "file-service.shares.delete",
];

const ORG = "share-creator-access-org";
const DAY_MS = 24 * 60 * 60 * 1000;

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

const grant = (token: string, bucketName: string, userId: string, f: Flags) =>
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
    (await grant(owner.token, bucket.name, creator.userId, { canRead: true }))
      .status
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

describe("Share links and the access of whoever made them", () => {
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
      expect((await remove(creator.userId, "?revokeShares=true")).status).toBe(
        HTTP_STATUS.NO_CONTENT
      );
      expect((await shareRow(s.id)).revokedAt).not.toBeNull();
      const entry = await prisma.auditLogEntry.findFirstOrThrow({
        where: { entityType: "share", entityId: s.id, action: "DELETE" },
      });
      expect(entry.metadata).toMatchObject({
        reason: "organization_member_removed",
      });
    });
  });

  describe("PATCH /shares/by-id/:id loosening a share", () => {
    const patch = (
      token: string,
      bucketName: string,
      id: string,
      body: object
    ) =>
      axios.patch(
        `${BASE_URL}/buckets/${bucketName}/shares/by-id/${id}`,
        body,
        as(token)
      );

    it("is refused to a bucket writer who neither made the share nor manages the bucket", async () => {
      const { owner, bucket, share } = await setup();
      const writer = await member();
      await grant(owner.token, bucket.name, writer.userId, {
        canRead: true,
        canWrite: true,
        canDelete: true,
      });
      const expiresAt = new Date(Date.now() + DAY_MS);
      const s = await share({
        password: "secret-one",
        maxDownloads: 3,
        expiresAt: expiresAt.toISOString(),
      });
      const later = new Date(expiresAt.getTime() + DAY_MS).toISOString();
      const sooner = new Date(expiresAt.getTime() - 60_000).toISOString();

      for (const body of [
        { password: null },
        { maxDownloads: null },
        { maxDownloads: 4 },
        { expiresAt: later },
        { expiresAt: null },
      ]) {
        const res = await patch(writer.token, bucket.name, s.id, body);
        expect([body, res.status]).toEqual([body, HTTP_STATUS.FORBIDDEN]);
      }

      for (const body of [
        { maxDownloads: 2 },
        { expiresAt: sooner },
        { note: "tightened" },
        { password: "secret-two" },
      ]) {
        const res = await patch(writer.token, bucket.name, s.id, body);
        expect([body, res.status]).toEqual([body, HTTP_STATUS.OK]);
      }

      const revoke = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${s.id}`,
        as(writer.token)
      );
      expect(revoke.status).toBe(HTTP_STATUS.NO_CONTENT);
    });

    it("is allowed to the share's creator, the bucket's owner and file-service.admin", async () => {
      const { owner, creator, bucket, share } = await setup();
      const s = await share({ password: "secret", maxDownloads: 3 });

      expect(
        (await patch(creator.token, bucket.name, s.id, { maxDownloads: 5 }))
          .status
      ).toBe(HTTP_STATUS.OK);
      expect(
        (await patch(owner.token, bucket.name, s.id, { password: null })).status
      ).toBe(HTTP_STATUS.OK);
      expect(
        (await patch(adminToken, bucket.name, s.id, { maxDownloads: null }))
          .status
      ).toBe(HTTP_STATUS.OK);
      const row = await shareRow(s.id);
      expect(row.passwordHash).toBeNull();
      expect(row.maxDownloads).toBeNull();
    });
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
