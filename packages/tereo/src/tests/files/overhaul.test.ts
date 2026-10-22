import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrincipalToken } from "../support/principals.js";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import { randomUUID } from "crypto";
import FormData from "form-data";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  getTestUserId,
  grantTestPermission,
  testIdempotencyKey,
  uploadTestObject,
} from "../support/files.js";

interface ObjectResponse {
  id: string;
  key: string;
  contentType: string;
  sizeBytes: string;
  etag: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  createdAt: string;
  updatedAt?: string;
}

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("File Service Overhaul — end-to-end flows", () => {
  let testToken: string;

  beforeAll(async () => {
    testToken = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("Prefixes endpoint (UI tree view)", () => {
    it("lists common prefixes and leaf objects under a prefix", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });

      // Upload a small hierarchy
      await uploadTestObject(
        testToken,
        bucket.name,
        "docs/alpha.txt",
        createTestFile("aaaa", "alpha.txt", "text/plain")
      );
      await uploadTestObject(
        testToken,
        bucket.name,
        "docs/bravo.txt",
        createTestFile("bbbb", "bravo.txt", "text/plain")
      );
      await uploadTestObject(
        testToken,
        bucket.name,
        "images/cat.png",
        createTestFile("cccc", "cat.png", "image/png")
      );
      await uploadTestObject(
        testToken,
        bucket.name,
        "top-level.md",
        createTestFile("dddd", "top-level.md", "text/markdown")
      );

      const res = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/prefixes`,
        {
          headers: authHeader(testToken),
          params: { prefix: "", delimiter: "/" },
        }
      );

      expect(res.status).toBe(HTTP_STATUS.OK);
      const prefixNames = res.data.data
        .filter((e: { type: string }) => e.type === "prefix")
        .map((p: { prefix: string }) => p.prefix);
      expect(prefixNames).toContain("docs/");
      expect(prefixNames).toContain("images/");
      const leafKeys = res.data.data
        .filter((e: { type: string }) => e.type === "object")
        .map((o: { key: string }) => o.key);
      expect(leafKeys).toContain("top-level.md");
      expect(leafKeys).not.toContain("docs/alpha.txt"); // not a leaf at this level
    });

    it("drills into a prefix and returns its direct children", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      await uploadTestObject(
        testToken,
        bucket.name,
        "feeds/in/1.csv",
        createTestFile("x", "1.csv", "text/csv")
      );
      await uploadTestObject(
        testToken,
        bucket.name,
        "feeds/in/2.csv",
        createTestFile("y", "2.csv", "text/csv")
      );
      await uploadTestObject(
        testToken,
        bucket.name,
        "feeds/out/3.csv",
        createTestFile("z", "3.csv", "text/csv")
      );

      const res = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/prefixes`,
        {
          headers: authHeader(testToken),
          params: { prefix: "feeds/", delimiter: "/" },
        }
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      const prefixNames = res.data.data
        .filter((e: { type: string }) => e.type === "prefix")
        .map((p: { prefix: string }) => p.prefix);
      expect(prefixNames).toEqual(
        expect.arrayContaining(["feeds/in/", "feeds/out/"])
      );
    });

    it("groups by a delimiter longer than one character", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      await uploadTestObject(
        testToken,
        bucket.name,
        "a--b.txt",
        createTestFile("x", "b.txt", "text/plain")
      );
      await uploadTestObject(
        testToken,
        bucket.name,
        "plain.txt",
        createTestFile("y", "plain.txt", "text/plain")
      );

      const res = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/prefixes`,
        {
          headers: authHeader(testToken),
          params: { prefix: "", delimiter: "--" },
        }
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      const prefixNames = res.data.data
        .filter((e: { type: string }) => e.type === "prefix")
        .map((p: { prefix: string }) => p.prefix);
      expect(prefixNames).toEqual(["a--"]);
      const leafKeys = res.data.data
        .filter((e: { type: string }) => e.type === "object")
        .map((o: { key: string }) => o.key);
      expect(leafKeys).toEqual(["plain.txt"]);
    });
  });

  describe("ETag conditional requests", () => {
    it("returns 304 on GET with matching If-None-Match", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      const upload = await uploadTestObject(
        testToken,
        bucket.name,
        "etag-test.txt",
        createTestFile("hello", "etag-test.txt", "text/plain")
      );

      const res = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/etag-test.txt`,
        {
          headers: {
            ...authHeader(testToken),
            "If-None-Match": `"${upload.etag}"`,
          },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(304);
    });

    it("rejects PUT with If-None-Match: * when the object exists", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      await uploadTestObject(
        testToken,
        bucket.name,
        "exists.txt",
        createTestFile("first", "exists.txt", "text/plain")
      );

      const file = createTestFile("second", "exists.txt", "text/plain");
      const form = new FormData();
      form.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });
      const res = await axios.put(
        `${BASE_URL}/buckets/${bucket.name}/objects/exists.txt`,
        form,
        {
          headers: {
            ...authHeader(testToken),
            ...form.getHeaders(),
            "Idempotency-Key": testIdempotencyKey(),
            "If-None-Match": "*",
          },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(412);
    });
  });

  describe("Versioning", () => {
    it("lists versions, restores a prior version, and hard-deletes a version", async () => {
      const bucket = await createTestBucket(testToken, {
        policy: "private",
      });

      // Flip versioning on via bucket update. Content-Type must be set
      // explicitly — axios' auto-set can be suppressed when a `headers`
      // config is supplied without one, and the server ignores bodies
      // arriving without an `application/json` content type.
      await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        { versioningEnabled: true },
        {
          headers: {
            ...authHeader(testToken),
            "Content-Type": "application/json",
          },
        }
      );

      const key = "versioned.txt";
      const v1 = await uploadTestObject(
        testToken,
        bucket.name,
        key,
        createTestFile("v1", "v1.txt", "text/plain")
      );
      const v2 = await uploadTestObject(
        testToken,
        bucket.name,
        key,
        createTestFile("v2-content", "v2.txt", "text/plain")
      );

      const objectId = v1.id;

      const listRes = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}/versions`,
        { headers: authHeader(testToken) }
      );
      expect(listRes.status).toBe(HTTP_STATUS.OK);
      expect(listRes.data.data).toHaveLength(2);
      const current = listRes.data.data.find(
        (v: { isCurrent: boolean }) => v.isCurrent
      );
      const prior = listRes.data.data.find(
        (v: { isCurrent: boolean }) => !v.isCurrent
      );
      expect(current.etag).toBe(v2.etag);

      // Restore the prior version
      const restoreRes = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}/versions/${prior.versionId}/restore`,
        {},
        { headers: authHeader(testToken) }
      );
      expect(restoreRes.status).toBe(201);

      // The single-version GET carries restoredFromVersionId like the list.
      const restoredRes = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}/versions/${restoreRes.data.versionId}`,
        { headers: authHeader(testToken) }
      );
      expect(restoredRes.status).toBe(HTTP_STATUS.OK);
      expect(restoredRes.data.restoredFromVersionId).toBe(prior.versionId);
      const priorRes = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}/versions/${prior.versionId}`,
        { headers: authHeader(testToken) }
      );
      expect(priorRes.data.restoredFromVersionId).toBeNull();

      // Verify the current download now reflects the old content
      const dl = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/${key}`,
        { headers: authHeader(testToken) }
      );
      expect(dl.data).toBe("v1");

      // Hard-delete the intermediate (non-current) v2
      const delRes = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}/versions/${prior.versionId}`,
        { headers: authHeader(testToken), validateStatus: () => true }
      );
      // prior is now isCurrent=false (restored on top). Deleting it is allowed.
      expect(delRes.status).toBe(HTTP_STATUS.NO_CONTENT);
      const gone = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}/versions/${prior.versionId}`,
        { headers: authHeader(testToken), validateStatus: () => true }
      );
      expect(gone.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("resolves each version's createdBy to the writer's email and name", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        { versioningEnabled: true },
        {
          headers: {
            ...authHeader(testToken),
            "Content-Type": "application/json",
          },
        }
      );

      const otherToken = await getTestPrincipalToken({
        permissions: ["file-service.admin"],
      });
      const otherUserId = JSON.parse(
        Buffer.from(otherToken.split(".")[1], "base64url").toString()
      ).sub as string;

      const key = "two-writers.txt";
      const v1 = await uploadTestObject(
        testToken,
        bucket.name,
        key,
        createTestFile("one", "one.txt", "text/plain")
      );
      await uploadTestObject(
        otherToken,
        bucket.name,
        key,
        createTestFile("two", "two.txt", "text/plain")
      );

      const listRes = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${v1.id}/versions`,
        { headers: authHeader(testToken) }
      );
      expect(listRes.status).toBe(HTTP_STATUS.OK);

      const writers = await prisma.user.findMany({
        where: { id: { in: [getTestUserId(), otherUserId] } },
      });
      expect(writers).toHaveLength(2);
      const rows = listRes.data.data as Array<{
        isCurrent: boolean;
        createdBy: string;
        createdByEmail: string | null;
        createdByName: string | null;
      }>;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const writer = writers.find((u) => u.id === row.createdBy);
        expect(writer).toBeDefined();
        expect(row.createdByEmail).toBe(writer!.email);
        expect(row.createdByName).toBe(writer!.name);
      }
      expect(rows.find((r) => r.isCurrent)?.createdBy).toBe(otherUserId);
      expect(rows.find((r) => !r.isCurrent)?.createdBy).toBe(getTestUserId());
    });

    it("inserts a delete marker on DELETE in a versioned bucket", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        { versioningEnabled: true },
        {
          headers: {
            ...authHeader(testToken),
            "Content-Type": "application/json",
          },
        }
      );

      const uploaded = await uploadTestObject(
        testToken,
        bucket.name,
        "to-tombstone.txt",
        createTestFile("bye", "to-tombstone.txt", "text/plain")
      );

      const delRes = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${uploaded.id}`,
        { headers: authHeader(testToken) }
      );
      expect(delRes.status).toBe(HTTP_STATUS.NO_CONTENT);

      const listRes = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${uploaded.id}/versions`,
        { headers: authHeader(testToken) }
      );
      const hasMarker = listRes.data.data.some(
        (v: { isDeleteMarker: boolean; isCurrent: boolean }) =>
          v.isDeleteMarker && v.isCurrent
      );
      expect(hasMarker).toBe(true);
    });
  });

  describe("Undelete by restoring a version", () => {
    const versionedBucket = async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        { versioningEnabled: true },
        {
          headers: {
            ...authHeader(testToken),
            "Content-Type": "application/json",
          },
        }
      );
      return bucket as { id: number; name: string };
    };

    // Uploads one version under `key`, deletes the object (a delete marker
    // in a versioned bucket) and returns its id and the content version.
    const deletedObject = async (bucketName: string, key: string) => {
      const uploaded = await uploadTestObject(
        testToken,
        bucketName,
        key,
        createTestFile("original", key, "text/plain")
      );
      const versions = await axios.get(
        `${BASE_URL}/buckets/${bucketName}/objects/by-id/${uploaded.id}/versions`,
        { headers: authHeader(testToken) }
      );
      const versionId = versions.data.data[0].versionId as string;
      const del = await axios.delete(
        `${BASE_URL}/buckets/${bucketName}/objects/by-id/${uploaded.id}`,
        { headers: authHeader(testToken) }
      );
      expect(del.status).toBe(HTTP_STATUS.NO_CONTENT);
      return { id: uploaded.id, versionId };
    };

    const restore = (
      bucketName: string,
      id: string,
      versionId: string,
      token = testToken
    ) =>
      axios.post(
        `${BASE_URL}/buckets/${bucketName}/objects/by-id/${id}/versions/${versionId}/restore`,
        {},
        { headers: authHeader(token), validateStatus: () => true }
      );

    it("brings a deleted object back under its key and id, and audits it", async () => {
      const bucket = await versionedBucket();
      const key = "undelete-me.txt";
      const { id, versionId } = await deletedObject(bucket.name, key);

      const gone = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/${key}`,
        { headers: authHeader(testToken), validateStatus: () => true }
      );
      expect(gone.status).toBe(HTTP_STATUS.NOT_FOUND);

      const res = await restore(bucket.name, id, versionId);
      expect(res.status).toBe(HTTP_STATUS.CREATED);

      const dl = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/${key}`,
        { headers: authHeader(testToken) }
      );
      expect(dl.data).toBe("original");
      const byKey = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-key/${key}`,
        { headers: authHeader(testToken) }
      );
      expect(byKey.data.id).toBe(id);

      const versions = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${id}/versions`,
        { headers: authHeader(testToken) }
      );
      const current = versions.data.data.filter(
        (v: { isCurrent: boolean }) => v.isCurrent
      );
      expect(current).toHaveLength(1);
      expect(current[0]).toMatchObject({
        versionId: res.data.versionId,
        isDeleteMarker: false,
        restoredFromVersionId: versionId,
      });
      // The delete marker stays in history.
      expect(
        versions.data.data.some(
          (v: { isDeleteMarker: boolean }) => v.isDeleteMarker
        )
      ).toBe(true);

      const object = await prisma.object.findUniqueOrThrow({ where: { id } });
      expect(object.deletedAt).toBeNull();
      expect(object.deletedBy).toBeNull();

      const audit = await prisma.auditLogEntry.findFirst({
        where: { entityType: "objectVersion", entityId: res.data.versionId },
      });
      expect(audit).toMatchObject({
        action: "CREATE",
        metadata: { restoredFromVersionId: versionId, undeleted: true },
      });
    });

    it("marks an ordinary restore as not undeleted", async () => {
      const bucket = await versionedBucket();
      const key = "plain-restore.txt";
      const v1 = await uploadTestObject(
        testToken,
        bucket.name,
        key,
        createTestFile("one", key, "text/plain")
      );
      const versions = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${v1.id}/versions`,
        { headers: authHeader(testToken) }
      );
      const firstVersionId = versions.data.data[0].versionId as string;
      await uploadTestObject(
        testToken,
        bucket.name,
        key,
        createTestFile("two", key, "text/plain")
      );

      const res = await restore(bucket.name, v1.id, firstVersionId);
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      const audit = await prisma.auditLogEntry.findFirst({
        where: { entityType: "objectVersion", entityId: res.data.versionId },
      });
      expect(audit?.metadata).toMatchObject({ undeleted: false });
    });

    it("clears an expiry that passed while the object was deleted", async () => {
      const bucket = await versionedBucket();
      const { id, versionId } = await deletedObject(bucket.name, "ttl.txt");
      await prisma.object.update({
        where: { id },
        data: { deleteAfter: new Date(Date.now() - 60_000) },
      });

      const res = await restore(bucket.name, id, versionId);
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      const object = await prisma.object.findUniqueOrThrow({ where: { id } });
      expect(object.deleteAfter).toBeNull();
    });

    it("keeps an expiry that is still ahead", async () => {
      const bucket = await versionedBucket();
      const { id, versionId } = await deletedObject(bucket.name, "ttl2.txt");
      const later = new Date(Date.now() + 86_400_000);
      await prisma.object.update({
        where: { id },
        data: { deleteAfter: later },
      });

      const res = await restore(bucket.name, id, versionId);
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      const object = await prisma.object.findUniqueOrThrow({ where: { id } });
      expect(object.deleteAfter?.getTime()).toBe(later.getTime());
    });

    it("409s when another object has taken the key since the delete", async () => {
      const bucket = await versionedBucket();
      const key = "taken.txt";
      const { id, versionId } = await deletedObject(bucket.name, key);
      const replacement = await uploadTestObject(
        testToken,
        bucket.name,
        key,
        createTestFile("replacement", key, "text/plain")
      );
      expect(replacement.id).not.toBe(id);

      const res = await restore(bucket.name, id, versionId);
      expect(res.status).toBe(HTTP_STATUS.CONFLICT);
      expect(res.data.error).toBe("conflict");

      const dl = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/${key}`,
        { headers: authHeader(testToken) }
      );
      expect(dl.data).toBe("replacement");
      const object = await prisma.object.findUniqueOrThrow({ where: { id } });
      expect(object.deletedAt).not.toBeNull();
    });

    it("still refuses to restore the delete marker itself", async () => {
      const bucket = await versionedBucket();
      const { id } = await deletedObject(bucket.name, "marker.txt");
      const versions = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${id}/versions`,
        { headers: authHeader(testToken) }
      );
      const marker = versions.data.data.find(
        (v: { isDeleteMarker: boolean }) => v.isDeleteMarker
      );

      const res = await restore(bucket.name, id, marker.versionId);
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(res.data.error).toBe("already_current");
    });

    it("needs objects.write and a bucket grant with canWrite", async () => {
      const bucket = await versionedBucket();
      const { id, versionId } = await deletedObject(bucket.name, "perm.txt");

      const principal = async (
        permissions: string[],
        grant: { canRead?: boolean; canWrite?: boolean }
      ) => {
        const userId = randomUUID();
        const token = await getTestPrincipalToken({
          userId,
          organizationId: null,
          permissions,
        });
        await grantTestPermission(testToken, bucket.name, userId, grant);
        return token;
      };

      const reader = await principal(["file-service.objects.read"], {
        canRead: true,
        canWrite: true,
      });
      expect((await restore(bucket.name, id, versionId, reader)).status).toBe(
        HTTP_STATUS.FORBIDDEN
      );

      const noGrant = await principal(["file-service.objects.write"], {
        canRead: true,
      });
      expect((await restore(bucket.name, id, versionId, noGrant)).status).toBe(
        HTTP_STATUS.FORBIDDEN
      );

      // Still deleted after the refusals.
      expect(
        (await prisma.object.findUniqueOrThrow({ where: { id } })).deletedAt
      ).not.toBeNull();

      const writer = await principal(["file-service.objects.write"], {
        canRead: true,
        canWrite: true,
      });
      expect((await restore(bucket.name, id, versionId, writer)).status).toBe(
        HTTP_STATUS.CREATED
      );
    });

    const listObjects = (bucketName: string, query: string) =>
      axios.get(`${BASE_URL}/buckets/${bucketName}/objects?${query}`, {
        headers: authHeader(testToken),
        validateStatus: () => true,
      });

    it("lists deleted objects with deleted=true, until one is restored", async () => {
      const bucket = await versionedBucket();
      const { id, versionId } = await deletedObject(bucket.name, "gone/a.txt");
      await deletedObject(bucket.name, "gone/b.txt");
      const live = await uploadTestObject(
        testToken,
        bucket.name,
        "live.txt",
        createTestFile("live", "live.txt", "text/plain")
      );

      const plain = await listObjects(bucket.name, "");
      expect(plain.data.data.map((o: { id: string }) => o.id)).toEqual([
        live.id,
      ]);

      const deleted = await listObjects(
        bucket.name,
        "deleted=true&sort=objectKey&sortDir=asc&limit=1"
      );
      expect(deleted.status).toBe(HTTP_STATUS.OK);
      expect(deleted.data.data).toEqual([
        {
          id,
          key: "gone/a.txt",
          deletedAt: expect.any(String),
          deletedBy: getTestUserId(),
          deletedByUser: {
            id: getTestUserId(),
            email: expect.any(String),
            name: expect.anything(),
          },
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
      ]);
      expect(deleted.data.hasMore).toBe(true);

      const next = await listObjects(
        bucket.name,
        `deleted=true&sort=objectKey&sortDir=asc&limit=1&cursor=${encodeURIComponent(deleted.data.nextCursor)}`
      );
      expect(next.data.data.map((o: { key: string }) => o.key)).toEqual([
        "gone/b.txt",
      ]);
      expect(next.data.hasMore).toBe(false);

      const filtered = await listObjects(
        bucket.name,
        "deleted=true&filter[objectKey]=b.txt&filter[objectKey_op]=contains"
      );
      expect(filtered.data.data.map((o: { key: string }) => o.key)).toEqual([
        "gone/b.txt",
      ]);

      expect((await restore(bucket.name, id, versionId)).status).toBe(
        HTTP_STATUS.CREATED
      );
      const after = await listObjects(bucket.name, "deleted=true");
      expect(after.data.data.map((o: { key: string }) => o.key)).toEqual([
        "gone/b.txt",
      ]);
    });

    it("refuses deleted=true with a sizeBytes sort, or a value other than true or false", async () => {
      const bucket = await versionedBucket();
      expect(
        (await listObjects(bucket.name, "deleted=true&sort=sizeBytes")).status
      ).toBe(HTTP_STATUS.BAD_REQUEST);
      expect((await listObjects(bucket.name, "deleted=yes")).status).toBe(
        HTTP_STATUS.BAD_REQUEST
      );
    });

    it("lists nothing deleted in a bucket without versioning, which keeps no version to restore", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      const uploaded = await uploadTestObject(
        testToken,
        bucket.name,
        "plain.txt",
        createTestFile("x", "plain.txt", "text/plain")
      );
      await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${uploaded.id}`,
        { headers: authHeader(testToken) }
      );
      const res = await listObjects(bucket.name, "deleted=true");
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.data.data).toEqual([]);
    });
  });

  describe("Expiry across overwrites", () => {
    const expiresAt = new Date(Date.now() + 7 * 86_400_000);

    // Uploads `key` and sets its expiry with PATCH; returns the object id.
    const expiringObject = async (bucketName: string, key: string) => {
      const uploaded = await uploadTestObject(
        testToken,
        bucketName,
        key,
        createTestFile("first", key, "text/plain")
      );
      const patch = await axios.patch(
        `${BASE_URL}/buckets/${bucketName}/objects/by-id/${uploaded.id}`,
        { deleteAfter: expiresAt.toISOString() },
        {
          headers: {
            ...authHeader(testToken),
            "Content-Type": "application/json",
          },
        }
      );
      expect(patch.status).toBe(HTTP_STATUS.OK);
      return uploaded.id;
    };

    const expectExpiryKept = async (id: string) => {
      const row = await prisma.object.findUniqueOrThrow({ where: { id } });
      expect(row.deleteAfter?.getTime()).toBe(expiresAt.getTime());
    };

    for (const versioningEnabled of [false, true]) {
      it(`keeps it through a simple upload (versioning ${versioningEnabled ? "on" : "off"})`, async () => {
        const bucket = await createTestBucket(testToken);
        if (versioningEnabled) {
          await axios.put(
            `${BASE_URL}/buckets/${bucket.name}`,
            { versioningEnabled: true },
            {
              headers: {
                ...authHeader(testToken),
                "Content-Type": "application/json",
              },
            }
          );
        }
        const id = await expiringObject(bucket.name, "keep.txt");

        const again = await uploadTestObject(
          testToken,
          bucket.name,
          "keep.txt",
          createTestFile("second", "keep.txt", "text/plain")
        );
        expect(again.id).toBe(id);
        await expectExpiryKept(id);

        const get = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${id}`,
          { headers: authHeader(testToken) }
        );
        expect(get.data.deleteAfter).toBe(expiresAt.toISOString());
      });
    }

    it("is cleared by PATCH deleteAfter: null, and the sweep leaves the object", async () => {
      const bucket = await createTestBucket(testToken);
      const id = await expiringObject(bucket.name, "clear.txt");

      const patch = await axios.patch(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${id}`,
        { deleteAfter: null },
        { headers: authHeader(testToken), validateStatus: () => true }
      );
      expect(patch.status).toBe(HTTP_STATUS.OK);
      const row = await prisma.object.findUniqueOrThrow({ where: { id } });
      expect(row.deleteAfter).toBeNull();

      // What the lifecycle sweep would soft-delete.
      const due = await db.lifecyclePolicies.findExpiredDeleteAfter(100_000);
      expect(due.map((o) => o.id)).not.toContain(id);
    });

    it("keeps it through a presigned write", async () => {
      const bucket = await createTestBucket(testToken);
      const id = await expiringObject(bucket.name, "presigned.txt");

      const presign = await axios.post<{ url: string }>(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${id}/presign`,
        { operation: "write", expiresInSeconds: 60 },
        { headers: authHeader(testToken) }
      );
      const put = await axios.put(presign.data.url, Buffer.from("second"), {
        headers: { "Content-Type": "text/plain" },
        validateStatus: () => true,
      });
      expect([HTTP_STATUS.OK, HTTP_STATUS.CREATED]).toContain(put.status);
      await expectExpiryKept(id);
    });

    it("keeps it through a completed multipart upload", async () => {
      const bucket = await createTestBucket(testToken);
      const id = await expiringObject(bucket.name, "big.bin");

      const init = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/multipart`,
        { objectKey: "big.bin", contentType: "application/octet-stream" },
        { headers: authHeader(testToken) }
      );
      expect(init.status).toBe(HTTP_STATUS.CREATED);
      const uploadId = init.data.uploadId as string;
      const part = await axios.put(
        `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}/parts/1`,
        Buffer.from("multipart body"),
        {
          headers: {
            ...authHeader(testToken),
            "Content-Type": "application/octet-stream",
          },
        }
      );
      expect(part.status).toBe(HTTP_STATUS.OK);
      const complete = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}/complete`,
        { parts: [{ partNumber: 1, etag: part.data.etag }] },
        {
          headers: {
            ...authHeader(testToken),
            "Idempotency-Key": testIdempotencyKey(),
          },
        }
      );
      expect([HTTP_STATUS.OK, HTTP_STATUS.CREATED]).toContain(complete.status);
      expect(complete.data.id).toBe(id);
      await expectExpiryKept(id);
    });

    it("is gone once the object is deleted and uploaded afresh", async () => {
      const bucket = await createTestBucket(testToken);
      const id = await expiringObject(bucket.name, "fresh.txt");
      const del = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${id}`,
        { headers: authHeader(testToken) }
      );
      expect(del.status).toBe(HTTP_STATUS.NO_CONTENT);

      const fresh = await uploadTestObject(
        testToken,
        bucket.name,
        "fresh.txt",
        createTestFile("new", "fresh.txt", "text/plain")
      );
      expect(fresh.id).not.toBe(id);
      const row = await prisma.object.findUniqueOrThrow({
        where: { id: fresh.id },
      });
      expect(row.deleteAfter).toBeNull();
    });
  });

  describe("Presigned URLs", () => {
    it("generates a signed URL and downloads through it without auth", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      const uploaded = await uploadTestObject(
        testToken,
        bucket.name,
        "signed.txt",
        createTestFile("signed-data", "signed.txt", "text/plain")
      );

      const presign = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${uploaded.id}/presign`,
        { operation: "read", expiresInSeconds: 60 },
        { headers: authHeader(testToken) }
      );
      expect(presign.status).toBe(HTTP_STATUS.OK);
      expect(presign.data.url).toContain("/signed/objects/");

      const res = await axios.get(presign.data.url, {
        validateStatus: () => true,
      });
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.data).toBe("signed-data");
    });

    it("rejects a signed URL with a tampered signature", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      const uploaded = await uploadTestObject(
        testToken,
        bucket.name,
        "sign-bad.txt",
        createTestFile("x", "sign-bad.txt", "text/plain")
      );

      const presign = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${uploaded.id}/presign`,
        { operation: "read", expiresInSeconds: 60 },
        { headers: authHeader(testToken) }
      );
      const url = new URL(presign.data.url);
      const sig = url.searchParams.get("sig")!;
      const tampered = sig.replace(/.$/, (c) => (c === "a" ? "b" : "a"));
      url.searchParams.set("sig", tampered);

      const res = await axios.get(url.toString(), {
        validateStatus: () => true,
      });
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    });
  });

  describe("Lifecycle policy", () => {
    it("upserts, reads, and deletes a lifecycle policy", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });

      const put = await axios.put(
        `${BASE_URL}/buckets/${bucket.name}/lifecycle`,
        { expireObjectsAfterDays: 30, enabled: true },
        { headers: authHeader(testToken) }
      );
      expect(put.status).toBe(HTTP_STATUS.OK);
      expect(put.data.expireObjectsAfterDays).toBe(30);

      const get = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/lifecycle`,
        { headers: authHeader(testToken) }
      );
      expect(get.status).toBe(HTTP_STATUS.OK);

      const del = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/lifecycle`,
        { headers: authHeader(testToken) }
      );
      expect(del.status).toBe(HTTP_STATUS.NO_CONTENT);

      const get404 = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/lifecycle`,
        { headers: authHeader(testToken), validateStatus: () => true }
      );
      expect(get404.status).toBe(HTTP_STATUS.NOT_FOUND);
    });
  });

  describe("Tags", () => {
    it("persists tags supplied via the X-Tags header", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      const file = createTestFile("tagged", "tagged.txt", "text/plain");
      const form = new FormData();
      form.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });

      const put = await axios.put<ObjectResponse>(
        `${BASE_URL}/buckets/${bucket.name}/objects/tagged.txt`,
        form,
        {
          headers: {
            ...authHeader(testToken),
            ...form.getHeaders(),
            "Idempotency-Key": testIdempotencyKey(),
            "X-Tags": "alpha, bravo",
          },
        }
      );
      expect(put.status).toBe(HTTP_STATUS.CREATED);
      expect(put.data.tags).toEqual(["alpha", "bravo"]);

      const list = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects`,
        { headers: authHeader(testToken) }
      );
      const row = list.data.data.find(
        (o: ObjectResponse) => o.key === "tagged.txt"
      );
      expect(row.tags).toEqual(["alpha", "bravo"]);
    });
  });

  describe("X-Tags forms", () => {
    const putWithTags = async (bucketName: string, xTags: string) => {
      const file = createTestFile("tagged", "tagged.txt", "text/plain");
      const form = new FormData();
      form.append("file", file.buffer, {
        filename: file.filename,
        contentType: file.contentType,
      });
      return await axios.put(
        `${BASE_URL}/buckets/${bucketName}/objects/tagged.txt`,
        form,
        {
          headers: {
            ...authHeader(testToken),
            ...form.getHeaders(),
            "Idempotency-Key": testIdempotencyKey(),
            "X-Tags": xTags,
          },
          validateStatus: () => true,
        }
      );
    };
    const asciiJson = (value: unknown) =>
      JSON.stringify(value).replace(
        /[\u0080-\uffff]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
      );

    it("reads a JSON array, so tags may hold any character and commas", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      const header = asciiJson(["日本語", "a,b"]);
      expect(header).toMatch(/^[\x20-\x7e]+$/);
      const put = await putWithTags(bucket.name, header);
      expect(put.status).toBe(HTTP_STATUS.CREATED);
      expect(put.data.tags).toEqual(["日本語", "a,b"]);
    });

    it("still reads the comma-separated form", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      const put = await putWithTags(bucket.name, " alpha ,, bravo");
      expect(put.status).toBe(HTTP_STATUS.CREATED);
      expect(put.data.tags).toEqual(["alpha", "bravo"]);
    });

    it.each([
      ["invalid JSON", '["a", '],
      ["a comma-form value starting with [", "[draft], final"],
      ["a non-string entry", '["a", 1]'],
      ["an empty tag", '["a", ""]'],
      ["an object", '[{"a":1}]'],
    ])("refuses %s rather than reading it as commas", async (_, header) => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      const put = await putWithTags(bucket.name, header);
      expect(put.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(put.data.error).toBe("invalid_request");
    });

    it("applies the count and length limits to the JSON form", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      const tooMany = await putWithTags(
        bucket.name,
        JSON.stringify(Array.from({ length: 51 }, (_, i) => `t${i}`))
      );
      expect(tooMany.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(tooMany.data.error).toBe("too_many_tags");
      const tooLong = await putWithTags(
        bucket.name,
        JSON.stringify(["x".repeat(129)])
      );
      expect(tooLong.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(tooLong.data.error).toBe("tag_too_long");
    });
  });

  describe("PATCH rename", () => {
    it("moves the object to a new key while preserving id + content", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      const uploaded = await uploadTestObject(
        testToken,
        bucket.name,
        "before/name.txt",
        createTestFile("renamed content", "name.txt", "text/plain")
      );
      const objectId = uploaded.id;

      const patch = await axios.patch<ObjectResponse>(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}`,
        { objectKey: "after/name.txt" },
        {
          headers: {
            ...authHeader(testToken),
            "Content-Type": "application/json",
          },
        }
      );
      expect(patch.status).toBe(HTTP_STATUS.OK);
      expect(patch.data.id).toBe(objectId);
      expect(patch.data.key).toBe("after/name.txt");

      // Old key is gone (partial-unique-on-live-key releases the slot).
      const oldGet = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/before/name.txt`,
        { headers: authHeader(testToken), validateStatus: () => true }
      );
      expect(oldGet.status).toBe(HTTP_STATUS.NOT_FOUND);

      // New key serves the same bytes.
      const newGet = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/after/name.txt`,
        { headers: authHeader(testToken), responseType: "text" }
      );
      expect(newGet.status).toBe(HTTP_STATUS.OK);
      expect(newGet.data).toBe("renamed content");

      // `by-id` still resolves — identity is stable across renames.
      const byId = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}`,
        { headers: authHeader(testToken) }
      );
      expect(byId.data.id).toBe(objectId);
      expect(byId.data.key).toBe("after/name.txt");
    });

    it("409s on rename collision with a live key", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      const a = await uploadTestObject(
        testToken,
        bucket.name,
        "a.txt",
        createTestFile("a", "a.txt", "text/plain")
      );
      await uploadTestObject(
        testToken,
        bucket.name,
        "b.txt",
        createTestFile("b", "b.txt", "text/plain")
      );

      const collide = await axios.patch(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${a.id}`,
        { objectKey: "b.txt" },
        {
          headers: {
            ...authHeader(testToken),
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
        }
      );
      expect(collide.status).toBe(HTTP_STATUS.CONFLICT);
    });
  });

  describe("Metadata limits outside the upload header", () => {
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`key${i}`, "value"])
    );
    const tooLarge = { blob: Array(20).fill("x".repeat(10_000)) };

    it("rejects oversized metadata on PATCH", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      const uploaded = await uploadTestObject(
        testToken,
        bucket.name,
        "meta-limits.txt",
        createTestFile("m", "meta-limits.txt", "text/plain")
      );
      for (const metadata of [tooManyKeys, tooLarge, { nested: { a: 1 } }]) {
        const res = await axios.patch(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${uploaded.id}`,
          { metadata },
          { headers: authHeader(testToken), validateStatus: () => true }
        );
        expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
      }

      const ok = await axios.patch(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${uploaded.id}`,
        { metadata: { reviewed: "yes", count: 2, flags: [true, null] } },
        { headers: authHeader(testToken), validateStatus: () => true }
      );
      expect(ok.status).toBe(HTTP_STATUS.OK);
    });

    it("rejects oversized metadata on multipart initiate", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      for (const metadata of [tooManyKeys, tooLarge]) {
        const res = await axios.post(
          `${BASE_URL}/buckets/${bucket.name}/multipart`,
          {
            objectKey: "meta-limits.bin",
            contentType: "application/octet-stream",
            metadata,
          },
          { headers: authHeader(testToken), validateStatus: () => true }
        );
        expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
      }
    });
  });

  describe("multipart expectedSize", () => {
    const completeWith = async (expectedSize: number, body: string) => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      const init = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/multipart`,
        {
          objectKey: "sized.bin",
          contentType: "application/octet-stream",
          expectedSize,
        },
        { headers: authHeader(testToken) }
      );
      expect(init.status).toBe(HTTP_STATUS.CREATED);
      const uploadId = init.data.uploadId as string;
      const part = await axios.put(
        `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}/parts/1`,
        Buffer.from(body),
        {
          headers: {
            ...authHeader(testToken),
            "Content-Type": "application/octet-stream",
          },
        }
      );
      expect(part.status).toBe(HTTP_STATUS.OK);
      return await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}/complete`,
        { parts: [{ partNumber: 1, etag: part.data.etag }] },
        {
          headers: {
            ...authHeader(testToken),
            "Idempotency-Key": testIdempotencyKey(),
          },
          validateStatus: () => true,
        }
      );
    };

    it("refuses parts totalling another size", async () => {
      const res = await completeWith(6, "12345");
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(res.data.error).toBe("size_mismatch");
    });

    it("completes parts totalling exactly that size", async () => {
      const res = await completeWith(5, "12345");
      expect([HTTP_STATUS.OK, HTTP_STATUS.CREATED]).toContain(res.status);
      expect(res.data.sizeBytes).toBe("5");
    });
  });

  describe("PATCH createNewVersion", () => {
    it("branches a new current version inheriting the content blob", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        { versioningEnabled: true },
        {
          headers: {
            ...authHeader(testToken),
            "Content-Type": "application/json",
          },
        }
      );

      const uploaded = await uploadTestObject(
        testToken,
        bucket.name,
        "branch.txt",
        createTestFile("branchable", "branch.txt", "text/plain")
      );
      const objectId = uploaded.id;
      const originalEtag = uploaded.etag;

      const patch = await axios.patch<ObjectResponse>(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}`,
        {
          metadata: { reviewed: "yes" },
          tags: ["prod"],
          createNewVersion: true,
        },
        {
          headers: {
            ...authHeader(testToken),
            "Content-Type": "application/json",
          },
        }
      );
      expect(patch.status).toBe(HTTP_STATUS.OK);
      // etag unchanged — same content blob.
      expect(patch.data.etag).toBe(originalEtag);
      expect(patch.data.tags).toEqual(["prod"]);

      // Two versions now exist for the same object — original as non-current,
      // branched as current — both pointing at the same contentBlobHash.
      const versions = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}/versions`,
        { headers: authHeader(testToken) }
      );
      expect(versions.data.data).toHaveLength(2);
      const hashes = new Set(
        versions.data.data.map(
          (v: { contentBlobHash: string }) => v.contentBlobHash
        )
      );
      expect(hashes.size).toBe(1); // same blob, two versions
      const current = versions.data.data.find(
        (v: { isCurrent: boolean }) => v.isCurrent
      );
      const prior = versions.data.data.find(
        (v: { isCurrent: boolean }) => !v.isCurrent
      );
      expect(current.tags).toEqual(["prod"]);
      expect(prior.tags).toEqual([]);
    });

    it("ignores createNewVersion on non-versioned buckets (in-place update)", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      const uploaded = await uploadTestObject(
        testToken,
        bucket.name,
        "inplace.txt",
        createTestFile("x", "inplace.txt", "text/plain")
      );

      await axios.patch(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${uploaded.id}`,
        { tags: ["t1"], createNewVersion: true },
        {
          headers: {
            ...authHeader(testToken),
            "Content-Type": "application/json",
          },
        }
      );

      // GET returns the same id and now-updated tags; no new version row was
      // created (can't list versions on a non-versioned bucket, so we rely on
      // the object metadata reflecting the in-place edit).
      const meta = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${uploaded.id}`,
        { headers: authHeader(testToken) }
      );
      expect(meta.data.tags).toEqual(["t1"]);
    });
  });

  describe("GET /objects/by-key/:objectKey", () => {
    it("resolves a key to the full object (including UUID id)", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      const uploaded = await uploadTestObject(
        testToken,
        bucket.name,
        "deep/path/file.txt",
        createTestFile("hi", "file.txt", "text/plain")
      );

      const res = await axios.get<ObjectResponse>(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-key/deep/path/file.txt`,
        { headers: authHeader(testToken) }
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.data.id).toBe(uploaded.id);
      expect(res.data.key).toBe("deep/path/file.txt");
    });

    it("returns 404 for a missing key", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      const res = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-key/missing.txt`,
        { headers: authHeader(testToken), validateStatus: () => true }
      );
      expect(res.status).toBe(HTTP_STATUS.NOT_FOUND);
    });
  });

  describe("GET /objects/by-id/:id/versions/:versionId/download", () => {
    it("streams a specific version's bytes by id (survives rename)", async () => {
      const bucket = await createTestBucket(testToken, { policy: "private" });
      await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        { versioningEnabled: true },
        {
          headers: {
            ...authHeader(testToken),
            "Content-Type": "application/json",
          },
        }
      );

      const v1 = await uploadTestObject(
        testToken,
        bucket.name,
        "doc.txt",
        createTestFile("v1 bytes", "doc.txt", "text/plain")
      );
      await uploadTestObject(
        testToken,
        bucket.name,
        "doc.txt",
        createTestFile("v2 bytes", "doc.txt", "text/plain")
      );

      const versions = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${v1.id}/versions`,
        { headers: authHeader(testToken) }
      );
      const priorVersionId = versions.data.data.find(
        (v: { isCurrent: boolean }) => !v.isCurrent
      ).versionId;

      // Rename the object — the id-addressed download URL should still work.
      await axios.patch(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${v1.id}`,
        { objectKey: "renamed.txt" },
        {
          headers: {
            ...authHeader(testToken),
            "Content-Type": "application/json",
          },
        }
      );

      const dl = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${v1.id}/versions/${priorVersionId}/download`,
        { headers: authHeader(testToken), responseType: "text" }
      );
      expect(dl.status).toBe(HTTP_STATUS.OK);
      expect(dl.data).toBe("v1 bytes");
    });
  });
});
