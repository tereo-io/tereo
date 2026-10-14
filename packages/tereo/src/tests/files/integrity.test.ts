import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { ensureTestUser } from "../utils/principals.js";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  grantTestPermission,
  uploadTestObject,
} from "./utils/test-helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `during` while a transaction holds `lock` (a statement that takes a
 * row lock), then commits. Lets a test queue a request behind the lock and
 * so fix the order two writers reach a row.
 */
async function whileLocked(
  lock: (tx: typeof prisma) => Promise<unknown>,
  during: () => Promise<void>
) {
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const holder = prisma.$transaction(
    async (tx) => {
      await lock(tx as unknown as typeof prisma);
      locked();
      await released;
    },
    { timeout: 30_000 }
  );
  await isLocked;
  try {
    await during();
  } finally {
    release();
    await holder;
  }
}

describe("files integrity", () => {
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

  const versionedBucket = async () => {
    const bucket = await createTestBucket(token);
    const res = await axios.put(
      `${BASE_URL}/buckets/${bucket.name}`,
      { versioningEnabled: true },
      auth()
    );
    expect(res.status).toBe(HTTP_STATUS.OK);
    return bucket as { id: number; name: string };
  };

  const upload = (bucketName: string, key: string, body: string) =>
    uploadTestObject(
      token,
      bucketName,
      key,
      createTestFile(body, key.split("/").pop(), "text/plain")
    );

  const usage = async (bucketId: number) =>
    (await prisma.bucket.findUniqueOrThrow({ where: { id: bucketId } }))
      .currentUsageBytes;

  const versions = (objectId: string) =>
    prisma.objectVersion.findMany({
      where: { objectId, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });

  describe("prefixes are literal", () => {
    it("bulk delete by prefix treats _ and % as characters", async () => {
      const bucket = await createTestBucket(token);
      await upload(bucket.name, "a_1.txt", `x ${randomUUID()}`);
      await upload(bucket.name, "ab1.txt", `y ${randomUUID()}`);

      const res = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/objects/bulk-delete`,
        { prefix: "a_" },
        auth()
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.data.deletedCount).toBe(1);

      const wildcard = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/objects/bulk-delete`,
        { prefix: "%" },
        auth()
      );
      expect(wildcard.data.deletedCount).toBe(0);

      const live = await prisma.object.findMany({
        where: { bucketId: bucket.id, deletedAt: null },
      });
      expect(live.map((o) => o.objectKey)).toEqual(["ab1.txt"]);
    });

    it("the prefix listing treats _ as a character", async () => {
      const bucket = await createTestBucket(token);
      await upload(bucket.name, "a_1.txt", `x ${randomUUID()}`);
      await upload(bucket.name, "abc/2.txt", `y ${randomUUID()}`);

      const res = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/prefixes`,
        { ...auth(), params: { prefix: "a_" } }
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.data.data).toEqual([
        expect.objectContaining({ type: "object", key: "a_1.txt" }),
      ]);
    });
  });

  it("pages through prefixes without listing a finished set again", async () => {
    const bucket = await createTestBucket(token);
    for (const key of ["d1/x.txt", "d2/x.txt", "o1.txt", "o2.txt", "o3.txt"]) {
      await upload(bucket.name, key, `${key} ${randomUUID()}`);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/prefixes`,
        { ...auth(), params: { limit: 2, ...(cursor ? { cursor } : {}) } }
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      for (const e of res.data.data as { prefix?: string; key?: string }[]) {
        seen.push(e.prefix ?? e.key!);
      }
      if (!res.data.hasMore) break;
      cursor = res.data.nextCursor;
    }
    expect(seen.sort()).toEqual(["d1/", "d2/", "o1.txt", "o2.txt", "o3.txt"]);
  });

  describe("deleting a version", () => {
    it("releases its blob ref once under concurrent deletes and refunds its usage", async () => {
      const bucket = await versionedBucket();
      const shared = `shared ${randomUUID()}`;
      const a = await upload(bucket.name, "a.txt", shared);
      await upload(bucket.name, "b.txt", shared);
      await upload(bucket.name, "a.txt", `a v2 ${randomUUID()}`);

      const [old] = await versions(a.id);
      const hash = old.contentBlobHash!;
      const size = BigInt(Buffer.byteLength(shared));
      expect(
        (await prisma.contentBlob.findUniqueOrThrow({ where: { hash } }))
          .refCount
      ).toBe(2);
      const before = await usage(bucket.id);

      const url = `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${a.id}/versions/${old.id}`;
      const statuses = (
        await Promise.all([
          axios.delete(url, auth()),
          axios.delete(url, auth()),
        ])
      )
        .map((r) => r.status)
        .sort();
      expect(statuses).toEqual([HTTP_STATUS.NO_CONTENT, HTTP_STATUS.NOT_FOUND]);

      expect(
        (await prisma.contentBlob.findUniqueOrThrow({ where: { hash } }))
          .refCount
      ).toBe(1);
      expect(await usage(bucket.id)).toBe(before - size);
    });

    it("a version branched by PATCH is charged, so deleting the old one leaves usage right", async () => {
      const bucket = await versionedBucket();
      const body = `branch ${randomUUID()}`;
      const size = BigInt(Buffer.byteLength(body));
      const obj = await upload(bucket.name, "b.txt", body);
      expect(await usage(bucket.id)).toBe(size);

      const patch = await axios.patch(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}`,
        { tags: ["branched"], createNewVersion: true },
        auth()
      );
      expect(patch.status).toBe(HTTP_STATUS.OK);
      expect(await usage(bucket.id)).toBe(2n * size);

      const [old] = await versions(obj.id);
      const del = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}/versions/${old.id}`,
        auth()
      );
      expect(del.status).toBe(HTTP_STATUS.NO_CONTENT);
      expect(await usage(bucket.id)).toBe(size);
    });

    it("markDeleted claims a version only once", async () => {
      const bucket = await versionedBucket();
      const obj = await upload(bucket.name, "m.txt", `m1 ${randomUUID()}`);
      await upload(bucket.name, "m.txt", `m2 ${randomUUID()}`);
      const [old] = await versions(obj.id);
      const claims = await prisma.$transaction(async (tx) => [
        await db.objectVersions.markDeleted(old.id, SYSTEM_USER_ID, tx),
        await db.objectVersions.markDeleted(old.id, SYSTEM_USER_ID, tx),
      ]);
      expect(claims).toEqual([true, false]);
    });
  });

  describe("lifecycle re-checks what it read", () => {
    it("leaves an object whose expiry was cleared since the sweep read it", async () => {
      const bucket = await createTestBucket(token);
      const obj = await upload(bucket.name, "ttl.txt", `ttl ${randomUUID()}`);
      await prisma.object.update({
        where: { id: obj.id },
        data: { deleteAfter: null },
      });

      const removed = await db.objects.removeExpiredObjects(
        bucket.id,
        [obj.id],
        { deleteAfterBefore: new Date() },
        SYSTEM_USER_ID
      );
      expect(removed).toEqual([]);
      expect(
        (await prisma.object.findUniqueOrThrow({ where: { id: obj.id } }))
          .deletedAt
      ).toBeNull();
    });

    it("never deletes the object that took over an expired object's key", async () => {
      const bucket = await createTestBucket(token);
      const old = await upload(bucket.name, "k.txt", `old ${randomUUID()}`);
      await prisma.objectVersion.updateMany({
        where: { objectId: old.id },
        data: { createdAt: new Date(Date.now() - 10 * DAY_MS) },
      });
      await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${old.id}`,
        auth()
      );
      const fresh = await upload(bucket.name, "k.txt", `new ${randomUUID()}`);

      const removed = await db.objects.removeExpiredObjects(
        bucket.id,
        [old.id],
        { lastWrittenBefore: new Date(Date.now() - DAY_MS) },
        SYSTEM_USER_ID
      );
      expect(removed).toEqual([]);
      expect(
        (await prisma.object.findUniqueOrThrow({ where: { id: fresh.id } }))
          .deletedAt
      ).toBeNull();
    });

    it("does not purge an object undeleted since the sweep read it", async () => {
      const bucket = await versionedBucket();
      const obj = await upload(bucket.name, "u.txt", `u ${randomUUID()}`);
      const del = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}`,
        auth()
      );
      expect(del.status).toBe(HTTP_STATUS.NO_CONTENT);
      await prisma.object.update({
        where: { id: obj.id },
        data: { deletedAt: new Date(Date.now() - 10 * DAY_MS) },
      });
      const [content] = await versions(obj.id);
      const restore = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}/versions/${content.id}/restore`,
        {},
        auth()
      );
      expect(restore.status).toBe(HTTP_STATUS.CREATED);

      const result = await db.objects.purgeSoftDeletedObjects(
        bucket.id,
        [obj.id],
        new Date(Date.now() - DAY_MS),
        true
      );
      expect(result.purgedIds).toEqual([]);
      expect(
        await prisma.object.findUnique({ where: { id: obj.id } })
      ).not.toBeNull();
    });
  });

  it("PATCH edits the version that is current when it runs", async () => {
    const bucket = await createTestBucket(token);
    const obj = await upload(bucket.name, "p.txt", `p1 ${randomUUID()}`);

    // The overwrite queues on the object's lock first, the PATCH after it.
    let overwrite: Promise<unknown> | undefined;
    let patching: Promise<{ status: number }> | undefined;
    await whileLocked(
      (tx) =>
        tx.$queryRaw`SELECT 1 FROM "files"."objects" WHERE "id" = ${obj.id}::uuid FOR UPDATE`,
      async () => {
        overwrite = upload(bucket.name, "p.txt", `p2 ${randomUUID()}`);
        await sleep(1000);
        patching = axios.patch(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}`,
          { tags: ["patched"] },
          auth()
        );
        await sleep(1000);
      }
    );
    await overwrite;
    const patch = await patching!;

    expect(patch.status).toBe(HTTP_STATUS.OK);
    const current = await prisma.objectVersion.findFirstOrThrow({
      where: { objectId: obj.id, isCurrent: true, deletedAt: null },
    });
    expect(current.tags).toEqual(["patched"]);
  });

  it("an upload goes by the versioning setting at commit, not at arrival", async () => {
    const bucket = await createTestBucket(token);
    const obj = await upload(bucket.name, "v.txt", `v1 ${randomUUID()}`);

    let overwrite: Promise<unknown> | undefined;
    await whileLocked(
      (tx) =>
        tx.$executeRaw`UPDATE "files"."buckets" SET "versioning_enabled" = true WHERE "id" = ${bucket.id}`,
      async () => {
        overwrite = upload(bucket.name, "v.txt", `v2 ${randomUUID()}`);
        await sleep(1500);
      }
    );
    await overwrite;

    expect(await versions(obj.id)).toHaveLength(2);
  });

  describe("shares", () => {
    it("refuses a share of a delete marker", async () => {
      const bucket = await versionedBucket();
      const obj = await upload(bucket.name, "s.txt", `s ${randomUUID()}`);
      await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}`,
        auth()
      );
      const [content, marker] = await versions(obj.id);
      expect(marker.isDeleteMarker).toBe(true);
      await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}/versions/${content.id}/restore`,
        {},
        auth()
      );

      const res = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        { kind: "OBJECT", objectId: obj.id, versionId: marker.id },
        auth()
      );
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(res.data.error).toBe("cannot_share_delete_marker");
    });

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

    it("an expired archive's share is a 404 that counts no download", async () => {
      const bucket = await createTestBucket(token);
      await upload(bucket.name, "gone/1.txt", `1 ${randomUUID()}`);
      const created = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        { kind: "ARCHIVE", prefix: "gone/" },
        auth()
      );
      await prisma.archiveRequest.update({
        where: { id: created.data.archiveRequestId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await axios.get(created.data.url, {
        maxRedirects: 0,
        validateStatus: () => true,
      });
      expect(res.status).toBe(HTTP_STATUS.NOT_FOUND);
      const share = await prisma.share.findUniqueOrThrow({
        where: { id: created.data.id },
      });
      expect(share.downloadCount).toBe(0);
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

  it("grants and revokes once under concurrent requests", async () => {
    const bucket = await createTestBucket(token);
    const userId = await ensureTestUser(randomUUID());
    await grantTestPermission(token, bucket.name, userId, { canRead: true });

    const revokeUrl = `${BASE_URL}/buckets/${bucket.name}/permissions/${userId}`;
    const revokes = await Promise.all([
      axios.delete(revokeUrl, auth()),
      axios.delete(revokeUrl, auth()),
    ]);
    expect(revokes.map((r) => r.status).sort()).toEqual([
      HTTP_STATUS.NO_CONTENT,
      HTTP_STATUS.NOT_FOUND,
    ]);

    const grant = () =>
      axios.post(
        `${BASE_URL}/buckets/${bucket.name}/permissions`,
        { userId, canRead: true, canWrite: false, canDelete: false },
        auth()
      );
    const grants = await Promise.all([grant(), grant()]);
    expect(grants.map((r) => r.status).sort()).toEqual([
      HTTP_STATUS.CREATED,
      HTTP_STATUS.CONFLICT,
    ]);
  });

  it("writes no lifecycle audit entry when there was no policy to delete", async () => {
    const bucket = await createTestBucket(token);
    const res = await axios.delete(
      `${BASE_URL}/buckets/${bucket.name}/lifecycle`,
      auth()
    );
    expect(res.status).toBe(HTTP_STATUS.NO_CONTENT);
    expect(
      await prisma.auditLogEntry.count({
        where: { entityType: "lifecyclePolicy", entityId: String(bucket.id) },
      })
    ).toBe(0);
  });
});
