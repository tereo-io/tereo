import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_USER_ID } from "../../definitions/systemUser.js";
import { generateThumbnails } from "../../utils/thumbnails.js";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import axios from "axios";
import sharp from "sharp";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  getTestAccessToken,
  uploadTestObject,
} from "../support/files.js";

describe("thumbnails are not addressable by their own id", () => {
  let token: string;
  let bucketName: string;
  let parentId: string;
  let thumbId: string;

  const auth = () => ({
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });

  beforeAll(async () => {
    token = await getTestAccessToken();
    bucketName = (await createTestBucket(token)).name;
    const png = await sharp({
      create: {
        width: 1200,
        height: 1100,
        channels: 3,
        background: { r: 10, g: 200, b: 30 },
      },
    })
      .png()
      .toBuffer();
    const parent = await uploadTestObject(token, bucketName, "photo.png", {
      buffer: png,
      filename: "photo.png",
      contentType: "image/png",
    });
    parentId = parent.id;
    const row = await db.objects.get(parentId);
    const blob = row.versions[0].contentBlob!;
    await generateThumbnails({
      parentObjectId: parentId,
      bucketId: row.bucketId,
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
    const thumb = await prisma.object.findFirstOrThrow({
      where: { thumbnailFor: parentId, thumbnailSize: "medium" },
    });
    thumbId = thumb.id;

    const res = await axios.put(
      `${BASE_URL}/buckets/${bucketName}`,
      { autoThumbnails: true, versioningEnabled: true },
      auth()
    );
    expect(res.status).toBe(HTTP_STATUS.OK);
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("serves a ?thumbnail= download with the parent's id in X-Object-Id", async () => {
    const res = await axios.get(
      `${BASE_URL}/buckets/${bucketName}/objects/photo.png`,
      { ...auth(), params: { thumbnail: "medium" } }
    );
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(res.headers["x-object-id"]).toBe(parentId);
  });

  it("answers HEAD ?thumbnail= with the thumbnail's GET headers", async () => {
    const url = `${BASE_URL}/buckets/${bucketName}/objects/photo.png`;
    const opts = { ...auth(), params: { thumbnail: "medium" } };
    const get = await axios.get(url, opts);
    const head = await axios.head(url, opts);
    expect(head.status).toBe(HTTP_STATUS.OK);
    for (const name of [
      "content-type",
      "content-length",
      "etag",
      "last-modified",
      "cache-control",
      "content-disposition",
      "content-security-policy",
      "x-content-type-options",
      "x-object-id",
    ]) {
      expect([name, head.headers[name]]).toEqual([name, get.headers[name]]);
    }
    const parent = await axios.head(url, auth());
    expect(parent.headers.etag).not.toBe(head.headers.etag);
  });

  it("returns 404 for GET /objects/by-id/:thumbnailId", async () => {
    const res = await axios.get(
      `${BASE_URL}/buckets/${bucketName}/objects/by-id/${thumbId}`,
      auth()
    );
    expect(res.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it("returns 404 for a thumbnail's version history", async () => {
    const res = await axios.get(
      `${BASE_URL}/buckets/${bucketName}/objects/by-id/${thumbId}/versions`,
      auth()
    );
    expect(res.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it("refuses to presign a read of a thumbnail id", async () => {
    const res = await axios.post(
      `${BASE_URL}/buckets/${bucketName}/objects/by-id/${thumbId}/presign`,
      { operation: "read", expiresInSeconds: 60 },
      auth()
    );
    expect(res.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it("refuses an OBJECT share of a thumbnail id", async () => {
    const res = await axios.post(
      `${BASE_URL}/buckets/${bucketName}/shares`,
      { kind: "OBJECT", objectId: thumbId },
      auth()
    );
    expect(res.status).toBe(HTTP_STATUS.NOT_FOUND);
  });
});
