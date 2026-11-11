// @module-tag unit
// @module-tag files
import { isThumbnailSource } from "../../utils/thumbnails.js";
import { describe, expect, it } from "vitest";
import sharp from "sharp";

describe("isThumbnailSource", () => {
  it("takes raster images and leaves out SVG and non-images", () => {
    expect(isThumbnailSource("image/png")).toBe(true);
    expect(isThumbnailSource("image/svg+xml")).toBe(false);
    expect(isThumbnailSource("text/plain")).toBe(false);
  });
});

describe("the thumbnail decoder", () => {
  it("refuses SVG before parsing it, whatever the stored content type says", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>'
    );
    await expect(sharp(svg).metadata()).rejects.toThrow();
  });
});
