// @module-tag int
// @module-tag auth
import { brandingPrincipal } from "../../../../../support/branding.js";
import { CORE_URL } from "../../../../../support/coreUrl.js";
import { beforeAll, describe, expect, it } from "vitest";

const post = async (token: string, size: number, slot: string) => {
  const form = new FormData();
  form.append("slot", slot);
  form.append("file", new Blob([new Uint8Array(size)]), "big.png");
  const response = await fetch(`${CORE_URL}/v1/admin/branding/assets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: response.status, body: await response.json() };
};

describe("POST /v1/admin/branding/assets limits", () => {
  let token: string;

  beforeAll(async () => {
    token = (await brandingPrincipal(["branding.admin"])).token;
  });

  it("refuses a logo over 512 KB", async () => {
    const res = await post(token, 513 * 1024, "logo");
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("payload_too_large");
  });

  it("refuses a background over 5 MB", async () => {
    const res = await post(token, 5 * 1024 * 1024 + 1, "background");
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("payload_too_large");
  });
});
