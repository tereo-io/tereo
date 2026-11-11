// @module-tag int
// @module-tag files
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import FormData from "form-data";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  testIdempotencyKey,
  uploadTestObject,
} from "../../../../../../support/files.js";

describe("GET /v1/files/buckets/:name/objects and /objects/prefixes, POST /objects/bulk-delete", () => {
  let token: string;
  let bucket: { id: number; name: string };

  const auth = () => ({
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });

  const list = (query: string) =>
    axios.get<{ data: { key: string; sizeBytes: string }[] }>(
      `${BASE_URL}/buckets/${bucket.name}/objects?${query}`,
      auth()
    );

  const keys = (res: { data: { data: { key: string }[] } }) =>
    res.data.data.map((o) => o.key);

  const putWith = (key: string, headers: Record<string, string>) => {
    const form = new FormData();
    form.append("file", Buffer.from("u"), {
      filename: "u.txt",
      contentType: "text/plain",
    });
    return axios.put(
      `${BASE_URL}/buckets/${bucket.name}/objects/${key}`,
      form,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": testIdempotencyKey(),
          ...form.getHeaders(),
          ...headers,
        },
        validateStatus: () => true,
      }
    );
  };

  beforeAll(async () => {
    token = await getTestAccessToken();
    bucket = await createTestBucket(token, { policy: "private" });
    const put = (key: string, body: string, type: string) =>
      uploadTestObject(
        token,
        bucket.name,
        key,
        createTestFile(body, key.split("/").pop(), type)
      );
    await put("img/small.png", "p", "image/png");
    await put("img/large.png", "p".repeat(64), "image/png");
    await put("img/notes.txt", "n".repeat(32), "text/plain");
    await put("doc/readme.txt", "r".repeat(16), "text/plain");
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("list filters", () => {
    it("filters by the current version's content type", async () => {
      const exact = await list("filter[contentType]=image/png");
      expect(exact.status).toBe(HTTP_STATUS.OK);
      expect(keys(exact).sort()).toEqual(["img/large.png", "img/small.png"]);

      const partial = await list(
        "filter[contentType]=TEXT/&filter[contentType_op]=contains"
      );
      expect(partial.status).toBe(HTTP_STATUS.OK);
      expect(keys(partial).sort()).toEqual(["doc/readme.txt", "img/notes.txt"]);
    });

    it("keeps the filters when sorting by size", async () => {
      const byKey = await list(
        "sort=sizeBytes&sortDir=desc&filter[objectKey]=IMG/&filter[objectKey_op]=startsWith"
      );
      expect(byKey.status).toBe(HTTP_STATUS.OK);
      expect(keys(byKey).sort()).toEqual([
        "img/large.png",
        "img/notes.txt",
        "img/small.png",
      ]);
      const sizes = byKey.data.data.map((o) => Number(o.sizeBytes));
      expect(sizes).toEqual([...sizes].sort((a, b) => b - a));

      const byType = await list(
        "sort=sizeBytes&sortDir=asc&filter[contentType]=image/png"
      );
      expect(keys(byType)).toEqual(["img/small.png", "img/large.png"]);

      const both = await list(
        "sort=sizeBytes&filter[objectKey]=notes&filter[objectKey_op]=contains" +
          "&filter[contentType]=text/plain"
      );
      expect(keys(both)).toEqual(["img/notes.txt"]);

      const exactKey = await list(
        "sort=sizeBytes&filter[objectKey]=doc/readme.txt"
      );
      expect(keys(exactKey)).toEqual(["doc/readme.txt"]);

      // `_` is a literal, not LIKE's any-character.
      const wildcard = await list(
        "sort=sizeBytes&filter[objectKey]=img_&filter[objectKey_op]=startsWith"
      );
      expect(keys(wildcard)).toEqual([]);
    });
  });

  describe("a NUL character in the input", () => {
    it.each([
      ["a list filter", () => list("filter[objectKey]=a%00b")],
      [
        "a content type filter",
        () => list("filter[contentType]=a%00b&filter[contentType_op]=contains"),
      ],
      [
        "a prefix",
        () =>
          axios.get(
            `${BASE_URL}/buckets/${bucket.name}/objects/prefixes?prefix=a%00`,
            auth()
          ),
      ],
      [
        "a delimiter",
        () =>
          axios.get(
            `${BASE_URL}/buckets/${bucket.name}/objects/prefixes?delimiter=%00`,
            auth()
          ),
      ],
      [
        "a bulk-delete prefix",
        () =>
          axios.post(
            `${BASE_URL}/buckets/${bucket.name}/objects/bulk-delete`,
            { prefix: "a\u0000" },
            auth()
          ),
      ],
      [
        "metadata on an update",
        async () => {
          const object = await uploadTestObject(
            token,
            bucket.name,
            "nul/meta.txt",
            createTestFile("m", "meta.txt", "text/plain")
          );
          return axios.patch(
            `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${object.id}`,
            { metadata: { note: "a\u0000b" } },
            auth()
          );
        },
      ],
      [
        "metadata on an upload",
        () => putWith("nul/upload.txt", { "X-Metadata": '{"k\\u0000":"v"}' }),
      ],
      [
        "tags on an upload",
        () => putWith("nul/tags.txt", { "X-Tags": '["a\\u0000"]' }),
      ],
    ])("is a 400 in %s", async (_label, send) => {
      const res = await send();
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });
});
