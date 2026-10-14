import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  generateUniqueId,
  getTestAccessToken,
  grantTestPermission,
  uploadTestObject,
} from "./utils/test-helpers.js";
import {
  FIXTURE_USER_IDS,
  ensureTestMembership,
  ensureTestUser,
  getTestPrincipalToken,
  testOrgId,
} from "../utils/principals.js";

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

describe("Bucket access", () => {
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
      expect(mine.data).toStrictEqual({
        canRead: false,
        canWrite: false,
        canDelete: false,
      });
    });
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

    it("returns false, not null, without a grant", async () => {
      const bucket = await createTestBucket(creatorToken);
      const res = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/my-permissions`,
        as(outsiderToken)
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.data).toStrictEqual({
        canRead: false,
        canWrite: false,
        canDelete: false,
      });
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
          const res = await axios.get(`${BASE_URL}${path}`, as(outsiderToken));
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

    it("hide a private bucket's versioning setting from a caller without access", async () => {
      const bucket = await createTestBucket(creatorToken);
      const url = `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${randomUUID()}/versions`;

      expect((await axios.get(url, as(outsiderToken))).status).toBe(
        HTTP_STATUS.FORBIDDEN
      );
      expect((await axios.get(url, as())).status).toBe(
        HTTP_STATUS.UNAUTHORIZED
      );
      const own = await axios.get(url, as(creatorToken));
      expect(own.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(own.data.error).toBe("versioning_disabled");
    });
  });

  describe("anonymous reads", () => {
    it("are 401 on a private or missing bucket, and served from a public one", async () => {
      const priv = await createTestBucket(creatorToken);
      const pub = await createTestBucket(creatorToken, { policy: "public" });

      const privRes = await axios.get(
        `${BASE_URL}/buckets/${priv.name}/objects`,
        as()
      );
      expect(privRes.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      const missing = await axios.get(
        `${BASE_URL}/buckets/test-bucket-${generateUniqueId()}/objects`,
        as()
      );
      expect(missing.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(missing.data).toEqual(privRes.data);

      const pubRes = await axios.get(
        `${BASE_URL}/buckets/${pub.name}/objects`,
        as()
      );
      expect(pubRes.status).toBe(HTTP_STATUS.OK);
    });

    const versionedObject = async (policy: "public" | "private") => {
      const bucket = await createTestBucket(creatorToken, { policy });
      const put = await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        { versioningEnabled: true },
        as(creatorToken)
      );
      expect(put.status).toBe(HTTP_STATUS.OK);
      const object = await uploadTestObject(
        creatorToken,
        bucket.name,
        "doc.txt",
        createTestFile("by id")
      );
      const base = `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${object.id}`;
      const versions = await axios.get(`${base}/versions`, as(creatorToken));
      expect(versions.status).toBe(HTTP_STATUS.OK);
      const versionId: string = versions.data.data[0].versionId;
      return { bucket, object, base, versionId };
    };

    it("by id are served from a public bucket without a token", async () => {
      const { object, base, versionId } = await versionedObject("public");

      const get = await axios.get(base, as());
      expect(get.status).toBe(HTTP_STATUS.OK);
      expect(get.data).toMatchObject({ id: object.id, key: "doc.txt" });

      const head = await axios.head(base, as());
      expect(head.status).toBe(HTTP_STATUS.OK);

      const list = await axios.get(`${base}/versions`, as());
      expect(list.status).toBe(HTTP_STATUS.OK);
      expect(
        list.data.data.map((v: { versionId: string }) => v.versionId)
      ).toEqual([versionId]);
      // Writers' identities are for the bucket's own readers only.
      expect(list.data.data[0]).toMatchObject({
        createdBy: creatorId,
        createdByEmail: null,
        createdByName: null,
      });
      const elsewhere = await getTestPrincipalToken({
        userId: randomUUID(),
        organizationId: OTHER_ORG,
        permissions: MEMBER,
      });
      const foreign = await axios.get(`${base}/versions`, as(elsewhere));
      expect(foreign.status).toBe(HTTP_STATUS.OK);
      expect(foreign.data.data[0].createdByEmail).toBeNull();
      const own = await axios.get(`${base}/versions`, as(creatorToken));
      expect(own.data.data[0].createdByEmail).toBe(
        `test-user-${creatorId}@example.com`
      );

      const version = await axios.get(`${base}/versions/${versionId}`, as());
      expect(version.status).toBe(HTTP_STATUS.OK);
      expect(version.data).toMatchObject({ versionId, isCurrent: true });

      const download = await axios.get(
        `${base}/versions/${versionId}/download`,
        as()
      );
      expect(download.status).toBe(HTTP_STATUS.OK);
      expect(download.data).toBe("by id");
    });

    it("by id are 401 anonymous and 403 without a grant on a private bucket", async () => {
      const { base, versionId } = await versionedObject("private");
      const paths = [
        "",
        "/versions",
        `/versions/${versionId}`,
        `/versions/${versionId}/download`,
      ];

      for (const path of paths) {
        const anon = await axios.get(`${base}${path}`, as());
        expect([path, anon.status]).toEqual([path, HTTP_STATUS.UNAUTHORIZED]);
        const outsider = await axios.get(`${base}${path}`, as(outsiderToken));
        expect([path, outsider.status]).toEqual([path, HTTP_STATUS.FORBIDDEN]);
        const own = await axios.get(`${base}${path}`, as(creatorToken));
        expect([path, own.status]).toEqual([path, HTTP_STATUS.OK]);
      }
      expect((await axios.head(base, as())).status).toBe(
        HTTP_STATUS.UNAUTHORIZED
      );
    });

    it("by id answer a missing bucket like a private one", async () => {
      const base = `${BASE_URL}/buckets/test-bucket-${generateUniqueId()}/objects/by-id/${randomUUID()}`;
      for (const path of ["", "/versions", `/versions/${randomUUID()}`]) {
        const anon = await axios.get(`${base}${path}`, as());
        expect([path, anon.status]).toEqual([path, HTTP_STATUS.UNAUTHORIZED]);
        const outsider = await axios.get(`${base}${path}`, as(outsiderToken));
        expect([path, outsider.status]).toEqual([path, HTTP_STATUS.FORBIDDEN]);
      }
    });

    it("by id still refuse writes on a public bucket without a token", async () => {
      const { base, versionId } = await versionedObject("public");
      const patch = await axios.patch(base, { tags: ["x"] }, as());
      expect(patch.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      const del = await axios.delete(`${base}/versions/${versionId}`, as());
      expect(del.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      const presign = await axios.post(
        `${base}/presign`,
        { operation: "read", expiresInSeconds: 60 },
        as()
      );
      expect(presign.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    });
  });

  describe("lifecycle policy", () => {
    it("is managed by the creator with bucket permissions alone", async () => {
      const userId = randomUUID();
      const token = await getTestPrincipalToken({
        userId,
        organizationId: ORG,
        permissions: ["file-service.buckets.delete"],
      });
      const bucket = await createTestBucket(token);
      const url = `${BASE_URL}/buckets/${bucket.name}/lifecycle`;

      const put = await axios.put(
        url,
        { expireObjectsAfterDays: 30 },
        as(token)
      );
      expect(put.status).toBe(HTTP_STATUS.OK);
      expect((await axios.get(url, as(token))).status).toBe(HTTP_STATUS.OK);
      expect((await axios.delete(url, as(token))).status).toBe(
        HTTP_STATUS.NO_CONTENT
      );
    });

    it("of a public bucket is not readable by a non-member", async () => {
      const bucket = await createTestBucket(creatorToken, { policy: "public" });
      const url = `${BASE_URL}/buckets/${bucket.name}/lifecycle`;
      await axios.put(url, { expireObjectsAfterDays: 30 }, as(creatorToken));

      expect((await axios.get(url, as(outsiderToken))).status).toBe(
        HTTP_STATUS.FORBIDDEN
      );
    });
  });

  describe("multipart abort", () => {
    const initiate = async (token: string, bucketName: string) => {
      const res = await axios.post(
        `${BASE_URL}/buckets/${bucketName}/multipart`,
        { objectKey: "big.bin", contentType: "application/octet-stream" },
        as(token)
      );
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      return res.data.uploadId as string;
    };

    it("needs the delete grant, not the write grant", async () => {
      const bucket = await createTestBucket(creatorToken);
      const userId = randomUUID();
      const token = await getTestPrincipalToken({
        userId,
        organizationId: ORG,
        permissions: MEMBER,
      });
      await grantInOrg(creatorToken, bucket.name, userId, {
        canRead: true,
        canWrite: true,
      });
      const uploadId = await initiate(token, bucket.name);

      const res = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}`,
        as(token)
      );
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it("checks access before looking up the upload", async () => {
      const bucket = await createTestBucket(creatorToken);
      const other = await createTestBucket(creatorToken);
      const uploadId = await initiate(creatorToken, bucket.name);
      const etag = "0".repeat(32);
      const calls = (name: string, id: string) => {
        const base = `${BASE_URL}/buckets/${name}/multipart/${id}`;
        return {
          list: (token: string) => axios.get(base, as(token)),
          part: (token: string) =>
            axios.put(`${base}/parts/1`, "x", {
              ...as(token),
              headers: {
                ...as(token).headers,
                "Content-Type": "application/octet-stream",
              },
            }),
          complete: (token: string) =>
            axios.post(
              `${base}/complete`,
              { parts: [{ partNumber: 1, etag }] },
              {
                ...as(token),
                headers: {
                  ...as(token).headers,
                  "Idempotency-Key": randomUUID(),
                },
              }
            ),
          abort: (token: string) => axios.delete(base, as(token)),
        };
      };

      for (const id of [uploadId, randomUUID()]) {
        for (const [op, call] of Object.entries(calls(bucket.name, id))) {
          const res = await call(outsiderToken);
          expect([op, id, res.status]).toEqual([op, id, HTTP_STATUS.FORBIDDEN]);
        }
      }

      for (const [op, call] of Object.entries(
        calls(bucket.name, randomUUID())
      )) {
        const res = await call(creatorToken);
        expect([op, res.status]).toEqual([op, HTTP_STATUS.NOT_FOUND]);
      }
      for (const [op, call] of Object.entries(calls(other.name, uploadId))) {
        const res = await call(creatorToken);
        expect([op, res.status]).toEqual([op, HTTP_STATUS.NOT_FOUND]);
      }
    });

    it("goes on in a retired bucket", async () => {
      const bucket = await createTestBucket(creatorToken);
      const uploadId = await initiate(creatorToken, bucket.name);
      await prisma.bucket.update({
        where: { id: bucket.id },
        data: { retiredAt: new Date() },
      });

      const res = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}`,
        as(creatorToken)
      );
      expect(res.status).toBe(HTTP_STATUS.NO_CONTENT);
    });
  });

  describe("share tokens", () => {
    it("are shown on list and get only to the share's creator and the bucket's writers", async () => {
      const bucket = await createTestBucket(creatorToken);
      const object = await uploadTestObject(
        creatorToken,
        bucket.name,
        "doc.txt",
        createTestFile("hello")
      );
      const sharesUrl = `${BASE_URL}/buckets/${bucket.name}/shares`;

      const readerId = randomUUID();
      const reader = await getTestPrincipalToken({
        userId: readerId,
        organizationId: ORG,
        permissions: MEMBER,
      });
      await grantInOrg(creatorToken, bucket.name, readerId, { canRead: true });
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

      const theirs = await axios.post(
        sharesUrl,
        { kind: "OBJECT", objectId: object.id },
        as(creatorToken)
      );
      const mine = await axios.post(
        sharesUrl,
        { kind: "OBJECT", objectId: object.id },
        as(reader)
      );
      expect(mine.status).toBe(HTTP_STATUS.CREATED);
      expect(mine.data.token).toEqual(expect.any(String));
      expect(mine.data.url).toEqual(expect.any(String));

      const tokensSeenBy = async (token: string) => {
        const list = await axios.get(sharesUrl, as(token));
        expect(list.status).toBe(HTTP_STATUS.OK);
        const byId = Object.fromEntries(
          (
            list.data.data as { id: string; token: unknown; url: unknown }[]
          ).map((s) => [s.id, { token: s.token, url: s.url }])
        );
        const get = await axios.get(
          `${sharesUrl}/by-id/${theirs.data.id}`,
          as(token)
        );
        expect(get.status).toBe(HTTP_STATUS.OK);
        return {
          theirs: byId[theirs.data.id],
          mine: byId[mine.data.id],
          get: { token: get.data.token, url: get.data.url },
        };
      };

      const revealed = { token: theirs.data.token, url: theirs.data.url };
      expect(await tokensSeenBy(reader)).toEqual({
        theirs: { token: null, url: null },
        mine: { token: mine.data.token, url: mine.data.url },
        get: { token: null, url: null },
      });
      expect(await tokensSeenBy(creatorToken)).toEqual({
        theirs: revealed,
        mine: { token: mine.data.token, url: mine.data.url },
        get: revealed,
      });
      expect(await tokensSeenBy(writer)).toEqual({
        theirs: revealed,
        mine: { token: mine.data.token, url: mine.data.url },
        get: revealed,
      });
    });
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

  describe("grant user ids", () => {
    it("are validated as UUIDs", async () => {
      const bucket = await createTestBucket(creatorToken);
      const url = `${BASE_URL}/buckets/${bucket.name}/permissions`;

      const grant = await axios.post(
        url,
        { userId: "not-a-uuid", canRead: true },
        as(creatorToken)
      );
      expect(grant.status).toBe(HTTP_STATUS.BAD_REQUEST);

      const revoke = await axios.delete(`${url}/not-a-uuid`, as(creatorToken));
      expect(revoke.status).toBe(HTTP_STATUS.BAD_REQUEST);

      // Any hex UUID is a user id, RFC variant or not.
      await ensureTestMembership(FIXTURE_USER_IDS[2], ORG);
      const fixture = await axios.post(
        url,
        { userId: FIXTURE_USER_IDS[2], canRead: true },
        as(creatorToken)
      );
      expect(fixture.status).toBe(HTTP_STATUS.CREATED);
    });
  });

  describe("grants in an organization's bucket", () => {
    const post = (token: string, bucketName: string, userId: string) =>
      axios.post(
        `${BASE_URL}/buckets/${bucketName}/permissions`,
        { userId, canRead: true },
        as(token)
      );

    it("refuse a user outside the organization, writing nothing", async () => {
      const bucket = await createTestBucket(creatorToken);
      const outsiderId = randomUUID();
      await ensureTestMembership(outsiderId, OTHER_ORG);

      const res = await post(creatorToken, bucket.name, outsiderId);
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(res.data.error).toBe("user_not_in_organization");

      expect(
        await prisma.bucketPermission.count({
          where: { bucketId: bucket.id, userId: outsiderId },
        })
      ).toBe(0);
      expect(
        await prisma.auditLogEntry.count({
          where: {
            entityType: "bucketPermission",
            entityName: `${bucket.name}:${outsiderId}`,
          },
        })
      ).toBe(0);
    });

    it("refuse a user in no organization, even for an admin", async () => {
      const bucket = await createTestBucket(creatorToken);
      const loneId = await ensureTestUser(randomUUID());

      for (const token of [creatorToken, adminToken]) {
        const res = await post(token, bucket.name, loneId);
        expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(res.data.error).toBe("user_not_in_organization");
      }
    });

    it("refuse renewing a revoked grant once the user has left", async () => {
      const bucket = await createTestBucket(creatorToken);
      const userId = randomUUID();
      await grantInOrg(creatorToken, bucket.name, userId, { canRead: true });
      const revoke = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/permissions/${userId}`,
        as(creatorToken)
      );
      expect(revoke.status).toBe(HTTP_STATUS.NO_CONTENT);
      await prisma.organizationMember.delete({
        where: {
          organizationId_userId: { organizationId: testOrgId(ORG), userId },
        },
      });

      const res = await post(creatorToken, bucket.name, userId);
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(res.data.error).toBe("user_not_in_organization");
      const row = await prisma.bucketPermission.findFirstOrThrow({
        where: { bucketId: bucket.id, userId },
      });
      expect(row.revokedAt).not.toBeNull();
    });

    it("accept the service-account user of a client bound to the organization", async () => {
      const bucket = await createTestBucket(creatorToken);
      const client = await prisma.oAuthClient.create({
        data: {
          clientId: `test-grant-client-${generateUniqueId()}`,
          name: "Grant test client",
          redirectUris: [],
          scopes: [],
          grantTypes: ["client_credentials"],
          ownerId: creatorId,
          organizationId: testOrgId(ORG),
        },
      });
      const serviceUserId = randomUUID();
      await prisma.user.create({
        data: {
          id: serviceUserId,
          email: `test-user-${serviceUserId}@example.com`,
          passwordHash: "!",
          userType: "service_account",
          oauthClientId: client.id,
        },
      });

      const res = await post(creatorToken, bucket.name, serviceUserId);
      expect(res.status).toBe(HTTP_STATUS.CREATED);
    });

    it("accept any user on a bucket in no organization", async () => {
      const orgless = await getTestPrincipalToken({
        organizationId: null,
        permissions: MEMBER,
      });
      const bucket = await createTestBucket(orgless);
      const loneId = await ensureTestUser(randomUUID());

      const res = await post(orgless, bucket.name, loneId);
      expect(res.status).toBe(HTTP_STATUS.CREATED);
    });
  });
});
