// @module-tag int
// @module-tag files
// @module-tag security
import { getTestPrincipalToken } from "../../support/principals.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import FormData from "form-data";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  generateUniqueId,
  getTestAccessToken,
  uploadTestObject,
} from "../../support/files.js";

describe("public bucket access", () => {
  describe("a public bucket's history", () => {
    const text = (content: string) => createTestFile(content, "a.txt");
    let token: string;
    let memberToken: string;
    let bucket: { id: number; name: string };
    let liveId: string;
    let liveOld: string;
    let deletedId: string;
    let deletedVersion: string;

    const anon = (target: string, params: Record<string, string> = {}) =>
      axios.get(target, { params, validateStatus: () => true });
    const as = (bearer: string, target: string, params = {}) =>
      axios.get(target, {
        params,
        headers: { Authorization: `Bearer ${bearer}` },
        validateStatus: () => true,
      });
    const objects = () => `${BASE_URL}/buckets/${bucket.name}/objects`;

    beforeAll(async () => {
      token = await getTestAccessToken();
      // Holds the read permission, but no grant on the bucket.
      memberToken = await getTestPrincipalToken({
        permissions: ["file-service.objects.read"],
      });
      bucket = await createTestBucket(token, { policy: "public" });
      await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        { versioningEnabled: true },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      liveId = (
        await uploadTestObject(token, bucket.name, "live.txt", text("v1"))
      ).id;
      await uploadTestObject(token, bucket.name, "live.txt", text("v2 secret"));
      liveOld = (
        await prisma.objectVersion.findFirstOrThrow({
          where: { objectId: liveId, isCurrent: false },
        })
      ).id;

      deletedId = (
        await uploadTestObject(token, bucket.name, "gone.txt", text("removed"))
      ).id;
      deletedVersion = (
        await prisma.objectVersion.findFirstOrThrow({
          where: { objectId: deletedId, isCurrent: true },
        })
      ).id;
      await axios.delete(`${objects()}/by-id/${deletedId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    it("does not list deleted objects to anyone it is public for", async () => {
      expect((await anon(objects(), { deleted: "true" })).status).toBe(
        HTTP_STATUS.UNAUTHORIZED
      );
      expect(
        (await as(memberToken, objects(), { deleted: "true" })).status
      ).toBe(HTTP_STATUS.FORBIDDEN);
      const reader = await as(token, objects(), { deleted: "true" });
      expect(reader.status).toBe(HTTP_STATUS.OK);
      expect(reader.data.data.map((o: { id: string }) => o.id)).toContain(
        deletedId
      );
    });

    it("does not serve a deleted object's versions", async () => {
      const versions = `${objects()}/by-id/${deletedId}/versions`;
      for (const target of [
        versions,
        `${versions}/${deletedVersion}`,
        `${versions}/${deletedVersion}/download`,
      ]) {
        expect([target, (await anon(target)).status]).toEqual([
          target,
          HTTP_STATUS.NOT_FOUND,
        ]);
        expect([target, (await as(memberToken, target)).status]).toEqual([
          target,
          HTTP_STATUS.NOT_FOUND,
        ]);
      }
      expect((await as(token, versions)).status).toBe(HTTP_STATUS.OK);
    });

    it("serves only the current version of a live object", async () => {
      const versions = `${objects()}/by-id/${liveId}/versions`;
      const list = await anon(versions);
      expect(list.status).toBe(HTTP_STATUS.OK);
      expect(list.data.data).toHaveLength(1);
      expect(list.data.data[0].isCurrent).toBe(true);

      expect((await anon(`${versions}/${liveOld}/download`)).status).toBe(
        HTTP_STATUS.NOT_FOUND
      );
      expect(
        (await anon(`${objects()}/live.txt`, { versionId: liveOld })).status
      ).toBe(HTTP_STATUS.NOT_FOUND);
      expect((await as(token, `${versions}/${liveOld}/download`)).status).toBe(
        HTTP_STATUS.OK
      );
    });

    it("names no writer, not even by id, to a caller it is public for", async () => {
      const list = await anon(`${objects()}/by-id/${liveId}/versions`);
      expect(list.data.data[0]).toMatchObject({
        createdBy: null,
        createdByEmail: null,
        createdByName: null,
        creator: null,
      });
      const reader = await as(token, `${objects()}/by-id/${liveId}/versions`);
      expect(reader.data.data[0].createdBy).toEqual(expect.any(String));
    });
  });

  describe("Object Management", () => {
    interface ObjectResponse {
      id: string;
      key: string;
      contentType: string;
      sizeBytes: string;
      etag: string;
      metadata?: Record<string, unknown>;
      createdAt: string;
      updatedAt?: string;
    }

    interface ObjectsListResponse {
      data: ObjectResponse[];
      hasMore: boolean;
      limit: number;
      nextCursor: string | null;
    }
    let testToken: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("Public bucket access", () => {
      let publicBucket: { id: number; name: string; policy: string };

      beforeAll(async () => {
        publicBucket = await createTestBucket(testToken, { policy: "public" });
      });

      it("should allow anonymous download from public bucket", async () => {
        const file = createTestFile(
          "Public content",
          "public.txt",
          "text/plain"
        );
        const objectKey = "public-test.txt";

        await uploadTestObject(testToken, publicBucket.name, objectKey, file);

        // Download without authentication
        const response = await axios.get(
          `${BASE_URL}/buckets/${publicBucket.name}/objects/${objectKey}`,
          {
            validateStatus: () => true,
            responseType: "text",
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        const content = response.data;
        expect(content).toBe("Public content");
      });

      it("should allow anonymous list from public bucket", async () => {
        // List without authentication
        const response = await axios.get<ObjectsListResponse>(
          `${BASE_URL}/buckets/${publicBucket.name}/objects`,
          {
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.OK);
        const data = response.data;
        expect(data.data).toBeDefined();
      });

      it("should require authentication for upload to public bucket", async () => {
        const file = createTestFile("Test", "test.txt", "text/plain");
        const formData = new FormData();
        formData.append("file", file.buffer, {
          filename: file.filename,
          contentType: file.contentType,
        });

        const response = await axios.put(
          `${BASE_URL}/buckets/${publicBucket.name}/objects/no-auth.txt`,
          formData,
          {
            headers: formData.getHeaders(),
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
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
          createdBy: null,
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
          expect([path, outsider.status]).toEqual([
            path,
            HTTP_STATUS.FORBIDDEN,
          ]);
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
          expect([path, outsider.status]).toEqual([
            path,
            HTTP_STATUS.FORBIDDEN,
          ]);
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
  });
});
