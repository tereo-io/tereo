// @module-tag int
// @module-tag auth
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../../support/coreUrl.js";
import { randomBytes } from "node:crypto";
import {
  brandingPrincipal,
  createBrandingClient,
  deleteBrandingClients,
  grantBranding,
} from "../../../../../support/branding.js";

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
  const clientIds: string[] = [];

  beforeAll(async () => {
    writer = await brandingPrincipal(["branding.write"]);
    clientIds.push((await createBrandingClient(writer.userId)).id);
  });

  afterAll(async () => {
    await deleteBrandingClients(clientIds);
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

    it("refuses branding.write without a client to edit", async () => {
      const nobody = await brandingPrincipal(["branding.write"]);
      const res = await upload(nobody.token, PNG, "logo");
      expect(res.status).toBe(403);
    });

    it("refuses a revoked grant and the owner of no client", async () => {
      const stranger = await brandingPrincipal([]);
      const client = await createBrandingClient(stranger.userId);
      clientIds.push(client.id);
      const revoked = await brandingPrincipal(["branding.write"]);
      await grantBranding(client.id, revoked.userId, true);
      const res = await upload(revoked.token, PNG, "logo");
      expect(res.status).toBe(403);
    });

    it("allows an active grantee, an owner and a branding.admin", async () => {
      const owner = await brandingPrincipal([]);
      const client = await createBrandingClient(owner.userId);
      clientIds.push(client.id);
      const grantee = await brandingPrincipal(["branding.write"]);
      await grantBranding(client.id, grantee.userId);
      const admin = await brandingPrincipal(["branding.admin"]);
      for (const p of [grantee, writer, admin]) {
        const png = Buffer.concat([PNG, randomBytes(16)]);
        expect((await upload(p.token, png, "logo")).status).toBe(201);
      }
    });

    it("writes an audit entry for a new image", async () => {
      const png = Buffer.concat([PNG, randomBytes(16)]);
      const res = await upload(writer.token, png, "logo");
      expect(res.status).toBe(201);
      const key = `${res.body.sha256}.png`;
      const entry = await prisma.auditLogEntry.findFirst({
        where: { entityType: "object", entityName: key, action: "CREATE" },
      });
      expect(entry).not.toBeNull();
    });

    it("refuses a request without a token", async () => {
      const res = await upload(null, PNG, "logo");
      expect(res.status).toBe(401);
    });
  });
});
