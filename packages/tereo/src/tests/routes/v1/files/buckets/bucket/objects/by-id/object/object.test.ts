// @module-tag int
// @module-tag files
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
  uploadTestObject,
} from "../../../../../../../../support/files.js";

describe("GET, PATCH and DELETE /v1/files/buckets/:name/objects/by-id/:id", () => {
  describe("Object Management", () => {
    let testToken: string;
    let testBucket: { id: number; name: string; policy: string };

    beforeAll(async () => {
      testToken = await getTestAccessToken();
      testBucket = await createTestBucket(testToken, { policy: "private" });
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("DELETE /buckets/:name/objects/*", () => {
      it("should delete an object", async () => {
        const file = createTestFile("Delete me", "delete.txt", "text/plain");
        const objectKey = "delete-test.txt";

        const { id } = await uploadTestObject(
          testToken,
          testBucket.name,
          objectKey,
          file
        );

        const response = await axios.delete(
          `${BASE_URL}/buckets/${testBucket.name}/objects/by-id/${id}`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.NO_CONTENT);

        // Verify object is deleted
        const getResponse = await axios.get(
          `${BASE_URL}/buckets/${testBucket.name}/objects/${objectKey}`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(getResponse.status).toBe(HTTP_STATUS.NOT_FOUND);
      });

      it("should return 404 for non-existent object", async () => {
        const response = await axios.delete(
          `${BASE_URL}/buckets/${testBucket.name}/objects/by-id/00000000-0000-4000-8000-000000000000`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      });

      it("should return 401 without authentication", async () => {
        const file = createTestFile("Test", "test.txt", "text/plain");
        const objectKey = "auth-delete-test.txt";

        const { id } = await uploadTestObject(
          testToken,
          testBucket.name,
          objectKey,
          file
        );

        const response = await axios.delete(
          `${BASE_URL}/buckets/${testBucket.name}/objects/by-id/${id}`,
          {
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      });
    });

    describe("Storage Quota Enforcement", () => {
      let quotaBucket: { id: number; name: string; policy: string };

      beforeAll(async () => {
        // Create bucket with 1KB quota
        quotaBucket = await createTestBucket(testToken, {
          policy: "private",
          storageQuotaBytes: "1024", // 1KB
        });
      });

      it("should update usage when deleting object", async () => {
        const file = createTestFile("delete me", "delete.txt", "text/plain");
        const { id } = await uploadTestObject(
          testToken,
          quotaBucket.name,
          "delete-usage.txt",
          file
        );

        // Get usage before delete
        const beforeResponse = await axios.get(
          `${BASE_URL}/buckets/${quotaBucket.name}`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );
        const usageBefore = parseInt(beforeResponse.data.currentUsageBytes);

        // Delete object
        await axios.delete(
          `${BASE_URL}/buckets/${quotaBucket.name}/objects/by-id/${id}`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        // Get usage after delete
        const afterResponse = await axios.get(
          `${BASE_URL}/buckets/${quotaBucket.name}`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );
        const usageAfter = parseInt(afterResponse.data.currentUsageBytes);

        expect(usageAfter).toBeLessThan(usageBefore);
      });
    });
  });

  describe("File Service Overhaul — end-to-end flows", () => {
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

    const authHeader = (token: string) => ({
      Authorization: `Bearer ${token}`,
    });
    let testToken: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("Versioning", () => {
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

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("PATCH /objects/by-id/:id deleteAfter", () => {
      const patch = (
        token: string,
        bucketName: string,
        id: string,
        body: Record<string, unknown>
      ) =>
        axios.patch(
          `${BASE_URL}/buckets/${bucketName}/objects/by-id/${id}`,
          body,
          as(token)
        );

      it("takes delete access to set, and only write to clear", async () => {
        const owner = await member();
        const writer = await member();
        const deleter = await member();
        const bucket = await createTestBucket(owner.token);
        await grant(owner.token, bucket.name, writer.userId, {
          canRead: true,
          canWrite: true,
        });
        await grant(owner.token, bucket.name, deleter.userId, {
          canRead: true,
          canWrite: true,
          canDelete: true,
        });
        const object = await uploadTestObject(
          owner.token,
          bucket.name,
          "ttl.txt",
          createTestFile("ttl")
        );
        const soon = new Date(Date.now() + 60_000).toISOString();

        const refused = await patch(writer.token, bucket.name, object.id, {
          deleteAfter: soon,
        });
        expect(refused.status).toBe(HTTP_STATUS.FORBIDDEN);
        let row = await prisma.object.findUniqueOrThrow({
          where: { id: object.id },
        });
        expect(row.deleteAfter).toBeNull();

        const set = await patch(deleter.token, bucket.name, object.id, {
          deleteAfter: soon,
        });
        expect(set.status).toBe(HTTP_STATUS.OK);
        expect(set.data.deleteAfter).toBe(soon);

        const cleared = await patch(writer.token, bucket.name, object.id, {
          deleteAfter: null,
        });
        expect(cleared.status).toBe(HTTP_STATUS.OK);
        row = await prisma.object.findUniqueOrThrow({
          where: { id: object.id },
        });
        expect(row.deleteAfter).toBeNull();

        const tags = await patch(writer.token, bucket.name, object.id, {
          tags: ["kept"],
        });
        expect(tags.status).toBe(HTTP_STATUS.OK);
      });

      it("takes the objects.delete role permission with the grant", async () => {
        const owner = await member();
        const writer = await member(["file-service.objects.write"]);
        const bucket = await createTestBucket(owner.token);
        await grant(owner.token, bucket.name, writer.userId, {
          canRead: true,
          canWrite: true,
          canDelete: true,
        });
        const object = await uploadTestObject(
          owner.token,
          bucket.name,
          "ttl.txt",
          createTestFile("ttl")
        );

        const res = await patch(writer.token, bucket.name, object.id, {
          deleteAfter: new Date(Date.now() + 60_000).toISOString(),
        });
        expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      });
    });
  });
});
