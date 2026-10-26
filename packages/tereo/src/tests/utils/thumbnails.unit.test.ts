// @module-tag unit
// @module-tag files
import { isThumbnailSource } from "../../utils/thumbnails.js";
import { describe, expect, it } from "vitest";

describe("isThumbnailSource", () => {
  it("takes raster images and leaves out SVG and non-images", () => {
    expect(isThumbnailSource("image/png")).toBe(true);
    expect(isThumbnailSource("image/svg+xml")).toBe(false);
    expect(isThumbnailSource("text/plain")).toBe(false);
  });
});
