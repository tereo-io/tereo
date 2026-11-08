// @module-tag int
// @module-tag auth
import { storeBrandingImage } from "../../../../../../utils/branding/storage.js";
import { SYSTEM_USER_ID } from "../../../../../../definitions/systemUser.js";
import { checkImage } from "../../../../../../utils/branding/images.js";
import { BASE_URL } from "../../../../../support/auth/constants.js";
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

const store = async (slot: "logo" | "favicon", bytes: Buffer) => {
  const image = await checkImage(slot, bytes);
  await storeBrandingImage(image, SYSTEM_USER_ID);
  return image;
};

const fetchAsset = (file: string) =>
  fetch(`${BASE_URL}/oauth/branding/assets/${file}`);

describe("GET /oauth/branding/assets/:file", () => {
  it("serves a stored PNG with immutable caching", async () => {
    const bytes = Buffer.concat([PNG, randomBytes(16)]);
    const image = await store("logo", bytes);
    const response = await fetchAsset(`${image.sha256}.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(image.buffer);
  });

  // The UI may be served from another origin (the Vite dev server, or a UI
  // hosted apart from core).
  it("lets other origins load an asset", async () => {
    const image = await store("logo", Buffer.concat([PNG, randomBytes(16)]));
    const response = await fetchAsset(`${image.sha256}.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "cross-origin"
    );
    await response.arrayBuffer();
  });

  it("serves an SVG sandboxed", async () => {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><!-- ${randomBytes(8).toString("hex")} --><rect width="1" height="1"/></svg>`
    );
    const image = await store("logo", svg);
    const response = await fetchAsset(`${image.sha256}.svg`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "image/svg+xml; charset=utf-8"
    );
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'; style-src 'unsafe-inline'"
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(image.buffer);
  });

  it("404s a malformed name, an unknown hash and a wrong extension", async () => {
    const image = await store("logo", Buffer.concat([PNG, randomBytes(16)]));
    for (const file of [
      "abc.png",
      `${"0".repeat(64)}.png`,
      `${image.sha256}.jpg`,
      `${image.sha256}.exe`,
    ]) {
      const response = await fetchAsset(file);
      expect(response.status, file).toBe(404);
      await response.arrayBuffer();
    }
  });
});
