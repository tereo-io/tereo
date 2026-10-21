import { grantBucketPermission } from "../requests/files/permissions/index.js";
import { createBucket, getBucket } from "../requests/files/buckets/index.js";
import { restoreObjectVersion } from "../requests/files/versions/index.js";
import { createArchive } from "../requests/files/archives/index.js";
import { createShare } from "../requests/files/shares/index.js";
import { InvalidRequestInputError } from "../utils/errors.js";
import { CORE_CLIENT, CORE_ONCE_CLIENT } from "../handler.js";
import { getHealth } from "../requests/files/health/index.js";
import { getUser } from "../requests/auth/users/index.js";
import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join } from "path";
import {
  initiateMultipart,
  uploadPart,
} from "../requests/files/multipart/index.js";
import {
  downloadObject,
  getObject,
  keyPath,
  listObjectsParams,
  uploadObject,
} from "../requests/files/objects/index.js";

const { tryHandleRequest } = vi.hoisted(() => ({ tryHandleRequest: vi.fn() }));
vi.mock("../utils/tryHandleRequest.js", () => ({ tryHandleRequest }));

describe("object key paths", () => {
  it("escapes each segment and keeps the slashes", () => {
    expect(keyPath("reports/2026 Q1/a#b?.pdf")).toBe(
      "reports/2026%20Q1/a%23b%3F.pdf"
    );
    expect(keyPath("plain/key.txt")).toBe("plain/key.txt");
  });

  it("refuses keys core refuses, and . segments the URL parser drops, without sending", async () => {
    for (const key of ["a/../b", "..", "a/./b", ".", "/a", "a/", "a//b", ""]) {
      expect(() => keyPath(key), key).toThrow(InvalidRequestInputError);
    }
    tryHandleRequest.mockReset();
    await expect(downloadObject("b", "docs/../secret")).rejects.toThrow(
      InvalidRequestInputError
    );
    await expect(
      uploadObject("b", "../x", { file: Buffer.from("x") })
    ).rejects.toThrow(InvalidRequestInputError);
    expect(tryHandleRequest).not.toHaveBeenCalled();
  });
});

describe("path parameters", () => {
  const sentUrl = () =>
    (tryHandleRequest.mock.calls.at(-1)?.[0] as { url: string }).url;

  it("are escaped as one segment each", async () => {
    tryHandleRequest.mockReset();
    tryHandleRequest.mockResolvedValue({ data: {} });
    await getObject("a/b", "x?y#z/w");
    expect(sentUrl()).toBe(
      "/v1/files/buckets/a%2Fb/objects/by-id/x%3Fy%23z%2Fw"
    );
    await getUser("../admin");
    expect(sentUrl()).toBe("/v1/admin/users/..%2Fadmin");
    await restoreObjectVersion("b", "o", "v?1");
    expect(sentUrl()).toBe(
      "/v1/files/buckets/b/objects/by-id/o/versions/v%3F1/restore"
    );
  });

  it("refuses an empty, . or .. parameter without sending", async () => {
    tryHandleRequest.mockReset();
    await expect(getObject("b", "..")).rejects.toThrow(
      InvalidRequestInputError
    );
    await expect(getUser(".")).rejects.toThrow(InvalidRequestInputError);
    await expect(getObject("", "id")).rejects.toThrow(InvalidRequestInputError);
    expect(tryHandleRequest).not.toHaveBeenCalled();
  });
});

describe("listObjects params", () => {
  it("sends filters in core's filter[field] / filter[field_op] form", () => {
    expect(
      listObjectsParams({
        limit: 10,
        sort: "objectKey",
        "objectKey:startsWith": "docs/",
        "contentType:equals": "image/png",
      })
    ).toEqual({
      limit: 10,
      sort: "objectKey",
      "filter[objectKey]": "docs/",
      "filter[objectKey_op]": "startsWith",
      "filter[contentType]": "image/png",
    });
  });

  it("sends deleted as core's true/false", () => {
    expect(listObjectsParams({ deleted: true, limit: 5 })).toEqual({
      deleted: "true",
      limit: 5,
    });
  });

  it("refuses two operators on one field, which core cannot combine", () => {
    expect(() =>
      listObjectsParams({
        "objectKey:contains": "a",
        "objectKey:startsWith": "b",
      })
    ).toThrow(/one operator/);
  });
});

describe("multipart parts", () => {
  it("are sent as octet-stream whatever contentType says, so core's body parsers leave them alone", async () => {
    tryHandleRequest.mockReset();
    tryHandleRequest.mockResolvedValue({ data: {} });
    await uploadPart("b", "u", 1, {
      body: Buffer.from("{}"),
      contentType: "application/json",
    });
    expect(tryHandleRequest.mock.calls[0][0]).toMatchObject({
      headers: { "Content-Type": "application/octet-stream" },
    });
  });
});

describe("creates core cannot dedupe", () => {
  it("go through the client that does not retry after a 5xx or a dropped connection", async () => {
    tryHandleRequest.mockReset();
    tryHandleRequest.mockResolvedValue({ data: {} });
    await createShare("b", { kind: "OBJECT", objectId: "o" } as never);
    await initiateMultipart("b", "k", {} as never);
    await createBucket({ name: "b" } as never);
    await createArchive("b", { prefix: "p" } as never);
    await grantBucketPermission("b", { userId: "u" } as never);
    await restoreObjectVersion("b", "o", "v");
    await getBucket("b");

    const clients = tryHandleRequest.mock.calls.map(
      ([config]) => (config as { clientName: string }).clientName
    );
    expect(clients.slice(0, 6)).toEqual(Array(6).fill(CORE_ONCE_CLIENT));
    expect(clients[6]).toBe(CORE_CLIENT);
  });
});

describe("upload headers", () => {
  const sentHeaders = () =>
    (
      tryHandleRequest.mock.calls.at(-1)?.[0] as {
        headers: Record<string, string>;
      }
    ).headers;

  it("send metadata as ASCII JSON that parses back unchanged", async () => {
    tryHandleRequest.mockReset();
    tryHandleRequest.mockResolvedValue({ data: {} });
    const metadata = { name: "日本語😀", note: "café\u007f" };
    await uploadObject("b", "k", { file: Buffer.from("x"), metadata });
    const header = sentHeaders()["X-Metadata"];
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    expect(header).toContain("\\ud83d\\ude00");
    expect(JSON.parse(header)).toEqual(metadata);
  });

  it("send tags as an ASCII JSON array, trimmed, commas and all", async () => {
    tryHandleRequest.mockReset();
    tryHandleRequest.mockResolvedValue({ data: {} });
    await uploadObject("b", "k", {
      file: Buffer.from("x"),
      tags: [" a ", "b", "", "日本語", "a,b", "[x]"],
    });
    const header = sentHeaders()["X-Tags"];
    expect(header).toMatch(/^\[[\x20-\x7e]+$/);
    expect(JSON.parse(header)).toEqual(["a", "b", "日本語", "a,b", "[x]"]);
  });

  it("refuse tags core would refuse, without sending", async () => {
    tryHandleRequest.mockReset();
    for (const tags of [
      Array.from({ length: 51 }, (_, i) => `t${i}`),
      ["x".repeat(129)],
    ]) {
      await expect(
        uploadObject("b", "k", { file: Buffer.from("x"), tags })
      ).rejects.toThrow(InvalidRequestInputError);
    }
    expect(tryHandleRequest).not.toHaveBeenCalled();
  });
});

describe("getHealth", () => {
  const degraded = {
    status: "degraded",
    service: "tereo",
    timestamp: "t",
    db: "fail",
  };

  it("returns core's degraded body, which comes with a 503", async () => {
    tryHandleRequest.mockReset();
    tryHandleRequest.mockResolvedValue({ status: 503, data: degraded });
    await expect(getHealth()).resolves.toEqual(degraded);
    const { validateStatus } = tryHandleRequest.mock.calls[0][0] as {
      validateStatus: (s: number) => boolean;
    };
    expect([200, 503].map(validateStatus)).toEqual([true, true]);
    expect([500, 502, 404].map(validateStatus)).toEqual([false, false, false]);
  });

  it("throws for a 503 that is not core's health body", async () => {
    tryHandleRequest.mockReset();
    tryHandleRequest.mockResolvedValue({ status: 503, data: "Unavailable" });
    await expect(getHealth()).rejects.toMatchObject({
      code: "FS_0030",
      httpStatus: 503,
    });
  });
});

describe("error codes", () => {
  it("are unique across the request modules", () => {
    const dir = fileURLToPath(new URL("../requests", import.meta.url));
    const codes = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith("index.ts"))
      .flatMap((f) => [
        ...readFileSync(join(dir, f), "utf8").matchAll(/"([A-Z]+_\d{4})"/g),
      ])
      .map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(50);
    expect(codes.filter((c, i) => codes.indexOf(c) !== i)).toEqual([]);
  });
});
