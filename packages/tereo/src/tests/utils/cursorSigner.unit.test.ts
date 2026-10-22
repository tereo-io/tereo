// @module-tag unit
// @module-tag platform
import { createCursorSigner } from "../../utils/cursorSigner.js";
import { requestPath } from "../../utils/requestId.js";
import { describe, expect, it } from "vitest";
import { createHmac } from "crypto";

const KEY = Buffer.alloc(32, 7).toString("base64");

const env = {
  CURSOR_SIGNING_KEY_V1: KEY,
  CURSOR_ACTIVE_SIGNING_KEY_VERSION: 1,
};

/** A signer whose current list is whatever `list.path` holds. */
const signerOn = (list: { path: string | undefined }) =>
  createCursorSigner({ env, prefix: "CURSOR", listScope: () => list.path });

const page = { sort: "createdAt", sortDir: "desc" as const };

const mint = (signer: ReturnType<typeof signerOn>) =>
  signer.encodeListCursor({
    ...page,
    sortValue: new Date("2026-10-01T00:00:00Z"),
    id: "row-1",
  });

describe("cursor list binding", () => {
  it("reads a cursor back on the list that minted it", () => {
    const list = { path: "/webhooks/v1/webhooks/a/deliveries" };
    const signer = signerOn(list);
    expect(signer.decodeListCursor(mint(signer), page).id).toBe("row-1");
  });

  it("refuses a cursor on another list with the same sort", () => {
    const list = { path: "/webhooks/v1/webhooks/a/deliveries" };
    const signer = signerOn(list);
    const cursor = mint(signer);

    list.path = "/webhooks/v1/webhooks/b/deliveries";
    expect(() => signer.decodeListCursor(cursor, page)).toThrow(/another list/);
  });

  it("refuses a version-1 cursor, which names no list", () => {
    const signer = signerOn({ path: "/admin/users" });
    const b64 = Buffer.from(
      JSON.stringify({
        v: 1,
        kv: 1,
        s: page.sort,
        d: page.sortDir,
        k: "2026-10-01T00:00:00.000Z",
        id: "row-1",
      })
    ).toString("base64url");
    const tag = createHmac("sha256", KEY)
      .update(b64)
      .digest()
      .subarray(0, 16)
      .toString("base64url");

    expect(() => signer.decodeListCursor(`${b64}.${tag}`, page)).toThrow(
      /version unsupported/
    );
  });

  it("normalizes the request path", () => {
    expect(requestPath("/admin/users/?limit=5")).toBe("/admin/users");
    expect(requestPath("/admin/users")).toBe("/admin/users");
    expect(requestPath("/")).toBe("/");
  });
});
