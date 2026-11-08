// @module-tag int
// @module-tag platform
// @module-tag security
import { MAX_PATH_BYTES, MAX_URL_BYTES } from "../../middleware/uriLength.js";
import { getTestAccessToken as getAuditToken } from "../support/audit.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestClient } from "../support/auth/clients.js";
import { CORE_URL } from "../support/coreUrl.js";
import {
  BASE_URL,
  cleanupTestEntities,
  createTestBucket,
  getTestAccessToken,
  uploadTestObject,
} from "../support/files.js";

const expectUriTooLong = async (res: Response) => {
  expect(res.status).toBe(414);
  expect(await res.json()).toMatchObject({ error: "uri_too_long" });
};

describe("uriLength", () => {
  it("answers 414 for a path over the limit", async () => {
    const path = `/v1/${"a".repeat(MAX_PATH_BYTES)}`;
    await expectUriTooLong(await fetch(`${CORE_URL}${path}`));
  });

  it("answers 414 for a long run of slashes before the UI's routes see it", async () => {
    const res = await fetch(`${CORE_URL}/login${"/".repeat(190_000)}x`);
    await expectUriTooLong(res);
  });

  it("answers 414 for a URL over the limit with a short path", async () => {
    const res = await fetch(
      `${CORE_URL}/health?x=${"a".repeat(MAX_URL_BYTES)}`
    );
    await expectUriTooLong(res);
  });

  it("counts bytes, not characters", async () => {
    // Each `é` is 2 UTF-8 bytes, 6 once percent-encoded.
    const segment = encodeURIComponent("é".repeat(MAX_PATH_BYTES / 6 + 1));
    await expectUriTooLong(await fetch(`${CORE_URL}/v1/${segment}`));
  });

  describe("long but legal URLs", () => {
    let token: string;

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    it("serves an object under a long key, every character percent-encoded", async () => {
      const bucket = await createTestBucket(token);
      const key = Array.from({ length: 4 }, () => " ".repeat(99)).join("/");
      const encodedKey = key.split("/").map(encodeURIComponent).join("/");
      await uploadTestObject(token, bucket.name, encodedKey, {
        buffer: Buffer.from("long key"),
        filename: "long.txt",
        contentType: "text/plain",
      });

      const res = await fetch(
        `${BASE_URL}/buckets/${bucket.name}/objects/${encodedKey}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("long key");
    });

    it("lets the longest audit entity id through, every byte percent-encoded", async () => {
      // 500 characters of 3 UTF-8 bytes each: 4500 bytes once encoded.
      const entityId = encodeURIComponent("€".repeat(500));
      const res = await fetch(
        `${CORE_URL}/v1/audit/entries/entity/Thing/${entityId}`,
        { headers: { Authorization: `Bearer ${await getAuditToken()}` } }
      );
      expect(res.status).toBe(200);
    });

    it("lets an /oauth/authorize request with long parameters through", async () => {
      const client = await createTestClient();
      const url = new URL(`${CORE_URL}/oauth/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", client.clientId);
      url.searchParams.set("redirect_uri", client.redirectUris[0]);
      url.searchParams.set("scope", "openid");
      url.searchParams.set("state", "{".repeat(512));
      url.searchParams.set("nonce", "}".repeat(512));
      url.searchParams.set("code_challenge", "a".repeat(43));
      url.searchParams.set("code_challenge_method", "S256");
      // A JSON string of 4096 characters, most of them percent-encoded.
      url.searchParams.set("claims", JSON.stringify("{".repeat(4094)));
      expect(url.href.length).toBeGreaterThan(8 * 1024);

      const res = await fetch(url, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/login");
    });
  });
});
