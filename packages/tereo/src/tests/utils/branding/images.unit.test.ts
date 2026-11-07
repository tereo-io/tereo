// @module-tag unit
// @module-tag auth
// @module-tag security
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  brandingAssetUrl,
  brandingObjectKey,
  checkImage,
  imageMaxBytes,
} from "../../../utils/branding/images.js";
import {
  BadRequestError,
  PayloadTooLargeError,
} from "../../../utils/errors.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"),
  Buffer.from([0xff, 0xd9]),
]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0x1a, 0, 0, 0]),
  Buffer.from("WEBPVP8 ", "latin1"),
  Buffer.alloc(18),
]);
const ICO = Buffer.concat([
  Buffer.from([
    0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 32, 0, 4, 0, 0, 0, 22, 0, 0, 0,
  ]),
  Buffer.alloc(4),
]);
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10z" fill="#0b5"/></svg>'
);

describe("checkImage", () => {
  it.each(["logo", "logoDark", "favicon", "background"] as const)(
    "accepts a PNG for %s",
    async (slot) => {
      const out = await checkImage(slot, PNG);
      expect(out.ext).toBe("png");
      expect(out.mime).toBe("image/png");
    }
  );

  it("accepts SVG for logo and favicon, not background", async () => {
    expect((await checkImage("logo", SVG)).ext).toBe("svg");
    expect((await checkImage("favicon", SVG)).mime).toBe("image/svg+xml");
    await expect(checkImage("background", SVG)).rejects.toBeInstanceOf(
      BadRequestError
    );
  });

  it("accepts an SVG with a BOM and xml prolog", async () => {
    const buf = Buffer.from(
      `${String.fromCharCode(0xfeff)}<?xml version="1.0"?>\n${SVG}`
    );
    expect((await checkImage("logo", buf)).ext).toBe("svg");
  });

  it("rejects an unsafe SVG with invalid_branding_image", async () => {
    const bad = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'
    );
    await expect(checkImage("logo", bad)).rejects.toMatchObject({
      code: "invalid_branding_image",
    });
  });

  it("accepts ICO only for favicon", async () => {
    expect((await checkImage("favicon", ICO)).ext).toBe("ico");
    await expect(checkImage("logo", ICO)).rejects.toBeInstanceOf(
      BadRequestError
    );
  });

  it("accepts JPEG and WebP for logo, rejects JPEG for favicon", async () => {
    expect((await checkImage("logo", JPEG)).ext).toBe("jpg");
    expect((await checkImage("logo", WEBP)).ext).toBe("webp");
    expect((await checkImage("background", JPEG)).ext).toBe("jpg");
    await expect(checkImage("favicon", JPEG)).rejects.toBeInstanceOf(
      BadRequestError
    );
  });

  it("takes the type from the bytes, not the content", async () => {
    await expect(
      checkImage("logo", Buffer.from("hello world"))
    ).rejects.toMatchObject({ code: "invalid_branding_image" });
  });

  it("rejects an oversized image", async () => {
    await expect(
      checkImage("logo", Buffer.alloc(imageMaxBytes("logo") + 1))
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("hashes the buffer and builds the object key and URL", async () => {
    const out = await checkImage("logo", PNG);
    const hex = createHash("sha256").update(PNG).digest("hex");
    expect(out.sha256).toBe(hex);
    expect(brandingObjectKey(out)).toBe(`${hex}.png`);
    expect(brandingAssetUrl(`${hex}.png`)).toBe(
      `/oauth/branding/assets/${hex}.png`
    );
  });
});

describe("imageMaxBytes", () => {
  it("uses the KB limit for icons and the MB limit for backgrounds", () => {
    expect(imageMaxBytes("logo")).toBe(512 * 1024);
    expect(imageMaxBytes("background")).toBe(5 * 1024 * 1024);
  });
});
