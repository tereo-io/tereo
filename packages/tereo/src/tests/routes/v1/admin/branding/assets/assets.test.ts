// @module-tag int
// @module-tag auth
import { brandingPrincipal } from "../../../../../support/branding.js";
import { CORE_URL } from "../../../../../support/coreUrl.js";
import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

type Principal = Awaited<ReturnType<typeof brandingPrincipal>>;

const URL_ = `${CORE_URL}/v1/admin/branding/assets`;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

const upload = async (
  token: string | null,
  file: Buffer | null,
  slot: string | null,
  filename = "image.bin"
) => {
  const form = new FormData();
  if (slot !== null) form.append("slot", slot);
  if (file) form.append("file", new Blob([new Uint8Array(file)]), filename);
  const response = await fetch(URL_, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

describe("POST /v1/admin/branding/assets", () => {
  let writer: Principal;

  beforeAll(async () => {
    writer = await brandingPrincipal(["branding.write"]);
  });

  describe("validation", () => {
    it("stores a PNG logo and the returned url serves it", async () => {
      const png = Buffer.concat([PNG, randomBytes(16)]);
      const res = await upload(writer.token, png, "logo");
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ ext: "png" });
      expect(res.body.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(res.body.url).toBe(
        `/oauth/branding/assets/${res.body.sha256}.png`
      );

      const served = await fetch(`${CORE_URL}${res.body.url}`);
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await served.arrayBuffer()).equals(png)).toBe(true);
    });

    it("answers the same content with the same hash", async () => {
      const png = Buffer.concat([PNG, randomBytes(16)]);
      const first = await upload(writer.token, png, "logo");
      const second = await upload(writer.token, png, "logoDark");
      expect(second.status).toBe(201);
      expect(second.body).toEqual(first.body);
    });

    it("refuses an SVG for the background slot", async () => {
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
      const res = await upload(writer.token, svg, "background");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_branding_image");
    });

    it("refuses an SVG with a script", async () => {
      const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
      );
      const res = await upload(writer.token, svg, "logo");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_branding_image");
      expect(res.body.error_description ?? res.body.message).toMatch(/svg/i);
    });

    it("refuses a missing slot", async () => {
      const res = await upload(writer.token, PNG, null);
      expect(res.status).toBe(400);
    });

    it("refuses an unknown slot", async () => {
      const res = await upload(writer.token, PNG, "banner");
      expect(res.status).toBe(400);
    });

    it("refuses a request without a file", async () => {
      const res = await upload(writer.token, null, "logo");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("file_upload_required");
    });
  });

  describe("permissions", () => {
    it("refuses a token without branding.write", async () => {
      const reader = await brandingPrincipal(["branding.read"]);
      const res = await upload(reader.token, PNG, "logo");
      expect(res.status).toBe(403);
    });

    it("refuses a request without a token", async () => {
      const res = await upload(null, PNG, "logo");
      expect(res.status).toBe(401);
    });
  });
});
