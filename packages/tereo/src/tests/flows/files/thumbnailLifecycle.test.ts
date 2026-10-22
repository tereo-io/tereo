// @module-tag int
// @module-tag files
import { getBlobPath, saveBlobBuffer } from "../../../utils/storage.js";
import { SYSTEM_USER_ID } from "../../../definitions/systemUser.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateThumbnails } from "../../../utils/thumbnails.js";
import { prisma } from "../../../utils/db/prisma.js";
import { randomBytes, randomInt } from "crypto";
import db from "../../../utils/db/index.js";
import axios from "axios";
import sharp from "sharp";
import {
  getOrphanBlobCleanupQueue,
  getThumbnailGenerationQueue,
} from "../../../jobs/queues.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  getTestAccessToken,
  testIdempotencyKey,
  uploadTestObject,
  waitFor,
} from "../../support/files.js";

describe("thumbnail lifecycle", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  // A distinct image each time, so no two parents share thumbnail blobs, and
  // larger than every size, so no two sizes do either.
  const png = () =>
    sharp({
      create: {
        width: 1100 + randomInt(200),
        height: 1100 + randomInt(200),
        channels: 3,
        background: { r: randomInt(256), g: randomInt(256), b: randomInt(256) },
      },
    })
      .png()
      .toBuffer();
  let token: string;

  const auth = () => ({
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });

  const uploadImage = async (bucketName: string, key: string) =>
    uploadTestObject(token, bucketName, key, {
      buffer: await png(),
      filename: "image.png",
      contentType: "image/png",
    });

  const generate = async (parentId: string) => {
    const parent = await db.objects.get(parentId);
    const blob = parent.versions[0].contentBlob!;
    await generateThumbnails({
      parentObjectId: parentId,
      bucketId: parent.bucketId,
      blobHash: blob.hash,
      blobMeta: {
        fsPath: blob.fsPath,
        keyMaterial: {
          wrappedDek: Buffer.from(blob.wrappedDek),
          iv: Buffer.from(blob.iv),
          masterKeyVersion: blob.masterKeyVersion,
        },
      },
      createdBy: SYSTEM_USER_ID,
    });
  };

  const thumbnailsOf = (parentId: string) =>
    prisma.object.findMany({
      where: { thumbnailFor: parentId },
      include: { versions: { include: { contentBlob: true } } },
    });

  const imageWithThumbnails = async (bucketName: string, key: string) => {
    const parent = await uploadImage(bucketName, key);
    await generate(parent.id);
    const thumbs = await thumbnailsOf(parent.id);
    expect(thumbs).toHaveLength(3);
    const hashes = thumbs.map((t) => t.versions[0].contentBlobHash!);
    return { parent, thumbs, hashes };
  };

  const refCounts = async (hashes: string[]) =>
    (
      await prisma.contentBlob.findMany({
        where: { hash: { in: hashes } },
        select: { refCount: true },
      })
    ).map((b) => b.refCount);

  const setAutoThumbnails = async (bucketName: string, on: boolean) => {
    const res = await axios.put(
      `${BASE_URL}/buckets/${bucketName}`,
      { autoThumbnails: on },
      auth()
    );
    expect(res.status).toBe(HTTP_STATUS.OK);
  };

  const getThumbnail = (bucketName: string, key: string) =>
    axios.get(`${BASE_URL}/buckets/${bucketName}/objects/${key}`, {
      params: { thumbnail: "medium" },
      validateStatus: () => true,
    });

  const text = (body: string) => ({
    buffer: Buffer.from(body),
    filename: "note.txt",
    contentType: "text/plain",
  });

  const versioned = async () => {
    const bucket = await createTestBucket(token);
    const res = await axios.put(
      `${BASE_URL}/buckets/${bucket.name}`,
      { versioningEnabled: true },
      auth()
    );
    expect(res.status).toBe(HTTP_STATUS.OK);
    return bucket;
  };

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("are served through the parent, not under their own key", async () => {
    const bucket = await createTestBucket(token, { policy: "public" });
    const { thumbs } = await imageWithThumbnails(bucket.name, "a.png");
    await setAutoThumbnails(bucket.name, true);

    const viaParent = await getThumbnail(bucket.name, "a.png");
    expect(viaParent.status).toBe(HTTP_STATUS.OK);
    expect(viaParent.headers["content-type"]).toBe("image/webp");

    for (const thumb of thumbs) {
      const direct = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/${thumb.objectKey}`,
        { validateStatus: () => true }
      );
      expect(direct.status).toBe(HTTP_STATUS.NOT_FOUND);
      const byKey = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-key/${thumb.objectKey}`,
        { validateStatus: () => true }
      );
      expect(byKey.status).toBe(HTTP_STATUS.NOT_FOUND);
    }
  });

  it("are not served while the bucket's autoThumbnails is off", async () => {
    const bucket = await createTestBucket(token, { policy: "public" });
    await imageWithThumbnails(bucket.name, "off.png");
    await setAutoThumbnails(bucket.name, true);
    expect((await getThumbnail(bucket.name, "off.png")).status).toBe(
      HTTP_STATUS.OK
    );

    await setAutoThumbnails(bucket.name, false);
    const off = await getThumbnail(bucket.name, "off.png");
    expect(off.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(off.data.error).toBe("not_found");
  });

  it("go when the parent is overwritten by an upload", async () => {
    for (const versioning of [false, true]) {
      const bucket = versioning
        ? await versioned()
        : await createTestBucket(token);
      const { parent, hashes } = await imageWithThumbnails(
        bucket.name,
        "o.png"
      );
      const over = await uploadTestObject(
        token,
        bucket.name,
        "o.png",
        text("no longer an image")
      );
      expect(over.id).toBe(parent.id);
      expect(await thumbnailsOf(parent.id)).toEqual([]);
      expect(await refCounts(hashes)).toEqual([0, 0, 0]);
    }
  });

  it("go when the parent is overwritten by a multipart upload", async () => {
    const bucket = await createTestBucket(token);
    const { parent, hashes } = await imageWithThumbnails(bucket.name, "m.png");
    const base = `${BASE_URL}/buckets/${bucket.name}/multipart`;
    const init = await axios.post(
      base,
      { objectKey: "m.png", contentType: "text/plain" },
      auth()
    );
    expect(init.status).toBe(HTTP_STATUS.CREATED);
    const { uploadId } = init.data;
    const part = await axios.put(
      `${base}/${uploadId}/parts/1`,
      Buffer.from("no longer an image"),
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
        },
        validateStatus: () => true,
      }
    );
    expect(part.status).toBe(HTTP_STATUS.OK);
    const complete = await axios.post(
      `${base}/${uploadId}/complete`,
      { parts: [{ partNumber: 1, etag: part.data.etag }] },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": testIdempotencyKey(),
        },
        validateStatus: () => true,
      }
    );
    expect(complete.status).toBe(HTTP_STATUS.OK);
    expect(complete.data.id).toBe(parent.id);
    expect(await thumbnailsOf(parent.id)).toEqual([]);
    expect(await refCounts(hashes)).toEqual([0, 0, 0]);
  });

  it("are queued again when an image overwrites an image", async () => {
    const bucket = await createTestBucket(token);
    const { parent, hashes } = await imageWithThumbnails(bucket.name, "n.png");
    await setAutoThumbnails(bucket.name, true);
    await uploadImage(bucket.name, "n.png");
    await waitFor(async () => {
      const thumbs = await thumbnailsOf(parent.id);
      return (
        thumbs.length === 3 &&
        thumbs.every((t) => !hashes.includes(t.versions[0].contentBlobHash!))
      );
    }, 15000);
    for (const job of await getThumbnailGenerationQueue().getJobs(
      ["completed", "failed"],
      0,
      -1
    )) {
      if (job.data.parentObjectId === parent.id) await job.remove();
    }
  });

  it("are keyed by their parent's id, so a rename leaves none behind", async () => {
    const bucket = await createTestBucket(token);
    const { parent, thumbs } = await imageWithThumbnails(bucket.name, "r.png");
    for (const thumb of thumbs) {
      expect(thumb.objectKey).toBe(
        `.thumbnails/${parent.id}/${thumb.thumbnailSize}`
      );
    }
  });

  it("cannot be deleted or renamed by id", async () => {
    const bucket = await createTestBucket(token);
    const { thumbs } = await imageWithThumbnails(bucket.name, "b.png");
    const url = `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${thumbs[0].id}`;
    expect((await axios.delete(url, auth())).status).toBe(
      HTTP_STATUS.NOT_FOUND
    );
    expect(
      (await axios.patch(url, { objectKey: "stolen.webp" }, auth())).status
    ).toBe(HTTP_STATUS.NOT_FOUND);
    expect(await thumbnailsOf(thumbs[0].thumbnailFor!)).toHaveLength(3);
  });

  it("go with a parent deleted by id, releasing their blobs", async () => {
    const bucket = await createTestBucket(token);
    const { parent, hashes } = await imageWithThumbnails(bucket.name, "c.png");
    const del = await axios.delete(
      `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${parent.id}`,
      auth()
    );
    expect(del.status).toBe(HTTP_STATUS.NO_CONTENT);
    expect(await thumbnailsOf(parent.id)).toEqual([]);
    expect(await refCounts(hashes)).toEqual([0, 0, 0]);
  });

  it("go with a parent deleted in a versioned bucket, and come back on restore", async () => {
    const bucket = await versioned();
    const { parent, hashes } = await imageWithThumbnails(bucket.name, "d.png");
    const del = await axios.delete(
      `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${parent.id}`,
      auth()
    );
    expect(del.status).toBe(HTTP_STATUS.NO_CONTENT);
    expect(await thumbnailsOf(parent.id)).toEqual([]);
    expect(await refCounts(hashes)).toEqual([0, 0, 0]);

    await prisma.bucket.update({
      where: { id: bucket.id },
      data: { autoThumbnails: true },
    });
    const [content] = await prisma.objectVersion.findMany({
      where: { objectId: parent.id, isDeleteMarker: false },
    });
    const restore = await axios.post(
      `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${parent.id}/versions/${content.id}/restore`,
      {},
      auth()
    );
    expect(restore.status).toBe(HTTP_STATUS.CREATED);
    await waitFor(
      async () => (await thumbnailsOf(parent.id)).length === 3,
      15000
    );
    for (const job of await getThumbnailGenerationQueue().getJobs(
      ["completed", "failed"],
      0,
      -1
    )) {
      if (job.data.parentObjectId === parent.id) await job.remove();
    }
  });

  it("go with parents deleted in bulk", async () => {
    const bucket = await createTestBucket(token);
    const byPrefix = await imageWithThumbnails(bucket.name, "p/e.png");
    const byId = await imageWithThumbnails(bucket.name, "f.png");
    const url = `${BASE_URL}/buckets/${bucket.name}/objects/bulk-delete`;
    expect((await axios.post(url, { prefix: "p/" }, auth())).status).toBe(
      HTTP_STATUS.OK
    );
    expect(
      (await axios.post(url, { ids: [byId.parent.id] }, auth())).status
    ).toBe(HTTP_STATUS.OK);
    for (const { parent, hashes } of [byPrefix, byId]) {
      expect(await thumbnailsOf(parent.id)).toEqual([]);
      expect(await refCounts(hashes)).toEqual([0, 0, 0]);
    }
  });

  it("go with a parent the lifecycle sweep expires", async () => {
    const bucket = await createTestBucket(token);
    const { parent, hashes } = await imageWithThumbnails(bucket.name, "g.png");
    await prisma.object.update({
      where: { id: parent.id },
      data: { deleteAfter: new Date(Date.now() - DAY_MS) },
    });
    const removed = await db.objects.removeExpiredObjects(
      bucket.id,
      [parent.id],
      { deleteAfterBefore: new Date() },
      SYSTEM_USER_ID
    );
    expect(removed.map((r) => r.id)).toEqual([parent.id]);
    expect(removed[0].releasedBlobHashes).toEqual(
      expect.arrayContaining(hashes)
    );
    expect(await thumbnailsOf(parent.id)).toEqual([]);
    expect(await refCounts(hashes)).toEqual([0, 0, 0]);
  });

  it("release their blobs when a soft-deleted parent is purged", async () => {
    const bucket = await createTestBucket(token);
    const { parent, hashes } = await imageWithThumbnails(bucket.name, "h.png");
    // A parent soft-deleted with its thumbnails left attached, as deletes
    // left them before thumbnails went with their parent.
    await prisma.object.update({
      where: { id: parent.id },
      data: { deletedAt: new Date(Date.now() - 10 * DAY_MS) },
    });
    const { purgedIds, freedHashes } = await db.objects.purgeSoftDeletedObjects(
      bucket.id,
      [parent.id],
      new Date(Date.now() - DAY_MS),
      true
    );
    expect(purgedIds).toEqual([parent.id]);
    expect(freedHashes).toEqual(expect.arrayContaining(hashes));
    expect(await thumbnailsOf(parent.id)).toEqual([]);
    expect(await refCounts(hashes)).toEqual([0, 0, 0]);
  });

  it("are not written for a parent deleted before the job runs", async () => {
    const bucket = await createTestBucket(token);
    const parent = await uploadImage(bucket.name, "i.png");
    const object = await db.objects.get(parent.id);
    const blob = object.versions[0].contentBlob!;
    await prisma.object.update({
      where: { id: parent.id },
      data: { deletedAt: new Date() },
    });
    await generateThumbnails({
      parentObjectId: parent.id,
      bucketId: bucket.id,
      blobHash: blob.hash,
      blobMeta: {
        fsPath: blob.fsPath,
        keyMaterial: {
          wrappedDek: Buffer.from(blob.wrappedDek),
          iv: Buffer.from(blob.iv),
          masterKeyVersion: blob.masterKeyVersion,
        },
      },
      createdBy: SYSTEM_USER_ID,
    });
    expect(await thumbnailsOf(parent.id)).toEqual([]);
  });

  it("queue cleanup of the blob a regenerated thumbnail releases", async () => {
    const bucket = await createTestBucket(token);
    const { parent, thumbs } = await imageWithThumbnails(bucket.name, "r.png");

    // Give one thumbnail other bytes than generating it again will produce.
    const version = thumbs[0].versions[0];
    const saved = await saveBlobBuffer(randomBytes(64));
    await prisma.$transaction(async (tx) => {
      await db.contentBlobs.attach(
        {
          hash: saved.hash,
          sizeBytes: BigInt(saved.sizeBytes),
          fsPath: getBlobPath(saved.hash),
          wrappedDek: saved.keyMaterial.wrappedDek,
          iv: saved.keyMaterial.iv,
          masterKeyVersion: saved.keyMaterial.masterKeyVersion,
          stagedPath: saved.stagedPath,
        },
        tx
      );
      await db.contentBlobs.incRef(saved.hash, tx);
      await db.contentBlobs.decRef(version.contentBlobHash!, tx);
      await tx.objectVersion.update({
        where: { id: version.id },
        data: { contentBlobHash: saved.hash },
      });
    });

    await generate(parent.id);

    expect(await refCounts([saved.hash])).toEqual([0]);
    const jobs = (
      await getOrphanBlobCleanupQueue().getJobs(
        ["wait", "delayed", "active", "completed", "failed"],
        0,
        -1
      )
    ).filter((job) => job.data.hash === saved.hash);
    expect(jobs).toHaveLength(1);
    for (const job of jobs) await job.remove();
  });
});
