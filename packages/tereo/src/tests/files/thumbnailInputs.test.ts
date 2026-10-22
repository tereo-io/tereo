import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import sharp from "sharp";
import {
  generateThumbnails,
  isThumbnailSource,
} from "../../utils/thumbnails.js";
import {
  cleanupTestEntities,
  createTestBucket,
  getTestAccessToken,
  uploadTestObject,
} from "../support/files.js";

const png = (width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 100, b: 50 },
    },
  })
    .png()
    .toBuffer();

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>'
);

describe("isThumbnailSource", () => {
  it("takes raster images and leaves out SVG and non-images", () => {
    expect(isThumbnailSource("image/png")).toBe(true);
    expect(isThumbnailSource("image/svg+xml")).toBe(false);
    expect(isThumbnailSource("text/plain")).toBe(false);
  });
});

describe("generateThumbnails inputs", () => {
  let token: string;
  let bucket: { id: number; name: string };

  beforeAll(async () => {
    token = await getTestAccessToken();
    bucket = await createTestBucket(token, { policy: "private" });
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  const thumbnailsFor = async (key: string, buffer: Buffer, type: string) => {
    const uploaded = await uploadTestObject(token, bucket.name, key, {
      buffer,
      filename: key,
      contentType: type,
    });
    const object = await db.objects.get(uploaded.id);
    const current = object.versions[0];
    await generateThumbnails({
      parentObjectId: object.id,
      bucketId: object.bucketId,
      blobHash: current.contentBlobHash!,
      blobMeta: {
        fsPath: current.contentBlob!.fsPath,
        keyMaterial: {
          wrappedDek: Buffer.from(current.contentBlob!.wrappedDek),
          iv: Buffer.from(current.contentBlob!.iv),
          masterKeyVersion: current.contentBlob!.masterKeyVersion,
        },
      },
      createdBy: current.createdBy,
    });
    return prisma.object.count({ where: { thumbnailFor: object.id } });
  };

  it("makes all three sizes for an ordinary image", async () => {
    expect(
      await thumbnailsFor("small.png", await png(64, 48), "image/png")
    ).toBe(3);
  });

  it("skips an image over the pixel limit without throwing", async () => {
    expect(
      await thumbnailsFor("huge.png", await png(8000, 7000), "image/png")
    ).toBe(0);
  });

  it("skips SVG content", async () => {
    expect(await thumbnailsFor("vector.svg", SVG, "image/svg+xml")).toBe(0);
  });
});
