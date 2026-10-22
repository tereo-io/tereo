// @module-tag int
// @module-tag files
// @module-tag race
import { prisma } from "../../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  ensureTestMembership,
  getTestPrincipalToken,
} from "../../../../../../../../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  grantTestPermission,
  uploadTestObject,
  uploadTestObjectAndGetId,
} from "../../../../../../../../support/files.js";

describe("GET, PATCH and DELETE /v1/files/buckets/:name/shares/by-id/:id", () => {
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

    describe("Revocation", () => {
      it("DELETE marks revoked and subsequent GET is 404 (uniform)", async () => {
        const createRes = await axios.post<ShareResponse>(
          `${BASE_URL}/buckets/${bucket.name}/shares`,
          { kind: "OBJECT", objectId },
          {
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
          }
        );
        expect(createRes.status).toBe(HTTP_STATUS.CREATED);

        const revokeRes = await axios.delete(
          `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${createRes.data.id}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
          }
        );
        expect(revokeRes.status).toBe(HTTP_STATUS.NO_CONTENT);

        const dlRes = await axios.get(createRes.data.url, {
          maxRedirects: 0,
          validateStatus: () => true,
        });
        expect(dlRes.status).toBe(HTTP_STATUS.NOT_FOUND);
      });

      it("idempotent double-revoke returns 204", async () => {
        const createRes = await axios.post<ShareResponse>(
          `${BASE_URL}/buckets/${bucket.name}/shares`,
          { kind: "OBJECT", objectId },
          {
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
          }
        );
        await axios.delete(
          `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${createRes.data.id}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
          }
        );
        const second = await axios.delete(
          `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${createRes.data.id}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
          }
        );
        expect(second.status).toBe(HTTP_STATUS.NO_CONTENT);
      });
    });

    describe("Expiry", () => {
      const MAX_MS = 365 * 24 * 60 * 60 * 1000;
      const expectAboutMaxFromNow = (expiresAt: string | null) => {
        expect(expiresAt).not.toBeNull();
        const delta = new Date(expiresAt!).getTime() - (Date.now() + MAX_MS);
        expect(Math.abs(delta)).toBeLessThan(60_000);
      };
      const create = async () => {
        const res = await axios.post<ShareResponse>(
          `${BASE_URL}/buckets/${bucket.name}/shares`,
          { kind: "OBJECT", objectId },
          { headers: { Authorization: `Bearer ${token}` } }
        );
        expect(res.status).toBe(HTTP_STATUS.CREATED);
        return res.data;
      };

      it("sets the longest expiry allowed on PATCH expiresAt: null", async () => {
        const share = await create();
        const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        await axios.patch(
          `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${share.id}`,
          { expiresAt: soon },
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const patch = await axios.patch<ShareResponse>(
          `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${share.id}`,
          { expiresAt: null },
          { headers: { Authorization: `Bearer ${token}` } }
        );
        expect(patch.status).toBe(HTTP_STATUS.OK);
        expectAboutMaxFromNow(patch.data.expiresAt);
      });
    });

    describe("List + Get + Update", () => {
      it("PATCH updates note + maxDownloads", async () => {
        const create = await axios.post<ShareResponse>(
          `${BASE_URL}/buckets/${bucket.name}/shares`,
          { kind: "OBJECT", objectId, note: "initial" },
          {
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
          }
        );
        const patch = await axios.patch<ShareResponse>(
          `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${create.data.id}`,
          { note: "updated", maxDownloads: 5 },
          {
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
          }
        );
        expect(patch.status).toBe(HTTP_STATUS.OK);
        expect(patch.data.maxDownloads).toBe(5);
        expect((patch.data as unknown as { note: string }).note).toBe(
          "updated"
        );
      });
    });
  });

  describe("files integrity", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    let token: string;
    const auth = () => ({
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    const upload = (bucketName: string, key: string, body: string) =>
      uploadTestObject(
        token,
        bucketName,
        key,
        createTestFile(body, key.split("/").pop(), "text/plain")
      );

    describe("shares", () => {
      it("a later expiry on an archive share extends its archive", async () => {
        const bucket = await createTestBucket(token);
        await upload(bucket.name, "arch/1.txt", `1 ${randomUUID()}`);
        const created = await axios.post(
          `${BASE_URL}/buckets/${bucket.name}/shares`,
          {
            kind: "ARCHIVE",
            prefix: "arch/",
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
          auth()
        );
        expect(created.status).toBe(HTTP_STATUS.CREATED);

        const later = new Date(Date.now() + 3 * DAY_MS);
        const patched = await axios.patch(
          `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${created.data.id}`,
          { expiresAt: later.toISOString() },
          auth()
        );
        expect(patched.status).toBe(HTTP_STATUS.OK);
        expect(
          new Date(patched.data.archiveRequest.expiresAt).getTime()
        ).toBeGreaterThan(later.getTime());
      });

      it("audits only one of two concurrent revokes", async () => {
        const bucket = await createTestBucket(token);
        const obj = await upload(bucket.name, "r.txt", `r ${randomUUID()}`);
        const created = await axios.post(
          `${BASE_URL}/buckets/${bucket.name}/shares`,
          { kind: "OBJECT", objectId: obj.id },
          auth()
        );
        const url = `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${created.data.id}`;
        const statuses = await Promise.all([
          axios.delete(url, auth()),
          axios.delete(url, auth()),
        ]);
        expect(statuses.map((r) => r.status)).toEqual([
          HTTP_STATUS.NO_CONTENT,
          HTTP_STATUS.NO_CONTENT,
        ]);
        expect(
          await prisma.auditLogEntry.count({
            where: {
              entityType: "share",
              entityId: created.data.id,
              action: "DELETE",
            },
          })
        ).toBe(1);
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
          (await patch(owner.token, bucket.name, s.id, { password: null }))
            .status
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
    let creatorId: string;
    let creatorToken: string;

    beforeAll(async () => {
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

    describe("share updates", () => {
      const createShare = async (bucketName: string) => {
        const object = await uploadTestObject(
          creatorToken,
          bucketName,
          "doc.txt",
          createTestFile("hello")
        );
        const res = await axios.post(
          `${BASE_URL}/buckets/${bucketName}/shares`,
          { kind: "OBJECT", objectId: object.id },
          as(creatorToken)
        );
        expect(res.status).toBe(HTTP_STATUS.CREATED);
        return res.data.id as string;
      };

      it("are 409 share_revoked on a revoked share", async () => {
        const bucket = await createTestBucket(creatorToken);
        const id = await createShare(bucket.name);
        const url = `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${id}`;
        await axios.delete(url, as(creatorToken));

        const res = await axios.patch(url, { note: "late" }, as(creatorToken));
        expect(res.status).toBe(HTTP_STATUS.CONFLICT);
        expect(res.data.error).toBe("share_revoked");
      });

      it("check permission before the retired state, and go on in a retired bucket", async () => {
        const bucket = await createTestBucket(creatorToken);
        const id = await createShare(bucket.name);
        const url = `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${id}`;

        const readerId = randomUUID();
        const reader = await getTestPrincipalToken({
          userId: readerId,
          organizationId: ORG,
          permissions: MEMBER,
        });
        await grantInOrg(creatorToken, bucket.name, readerId, {
          canRead: true,
        });
        const writerId = randomUUID();
        const writer = await getTestPrincipalToken({
          userId: writerId,
          organizationId: ORG,
          permissions: MEMBER,
        });
        await grantInOrg(creatorToken, bucket.name, writerId, {
          canRead: true,
          canWrite: true,
        });

        await prisma.bucket.update({
          where: { id: bucket.id },
          data: { retiredAt: new Date() },
        });

        expect((await axios.patch(url, { note: "x" }, as(reader))).status).toBe(
          HTTP_STATUS.FORBIDDEN
        );
        expect((await axios.patch(url, { note: "y" }, as(writer))).status).toBe(
          HTTP_STATUS.OK
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

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("PATCH /shares/by-id/:id", () => {
      it("is refused to a creator whose read grant was revoked", async () => {
        const owner = await member();
        const reader = await member();
        const bucket = await createTestBucket(owner.token);
        const object = await uploadTestObject(
          owner.token,
          bucket.name,
          "doc.txt",
          createTestFile("doc")
        );
        await grant(owner.token, bucket.name, reader.userId, { canRead: true });
        const share = await axios.post(
          `${BASE_URL}/buckets/${bucket.name}/shares`,
          { kind: "OBJECT", objectId: object.id },
          as(reader.token)
        );
        expect(share.status).toBe(HTTP_STATUS.CREATED);
        await revoke(owner.token, bucket.name, reader.userId);

        const res = await axios.patch(
          `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${share.data.id}`,
          { expiresAt: null },
          as(reader.token)
        );
        expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      });

      it("audits a changed password without the password", async () => {
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
          { kind: "OBJECT", objectId: object.id, password: "first-secret" },
          as(owner.token)
        );
        const res = await axios.patch(
          `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${share.data.id}`,
          { password: "second-secret" },
          as(owner.token)
        );
        expect(res.status).toBe(HTTP_STATUS.OK);

        const entry = await prisma.auditLogEntry.findFirstOrThrow({
          where: {
            entityType: "share",
            entityId: share.data.id,
            action: "UPDATE",
          },
        });
        expect(entry.metadata).toMatchObject({ passwordChanged: true });
        expect(JSON.stringify(entry)).not.toContain("second-secret");

        await axios.patch(
          `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${share.data.id}`,
          { note: "no password" },
          as(owner.token)
        );
        const later = await prisma.auditLogEntry.findFirstOrThrow({
          where: {
            entityType: "share",
            entityId: share.data.id,
            action: "UPDATE",
          },
          orderBy: { createdAt: "desc" },
        });
        expect(later.metadata).toMatchObject({ passwordChanged: false });
      });
    });
  });
});
