import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrincipalToken } from "../utils/principals.js";
import { open, rename, rm, writeFile } from "fs/promises";
import { prisma } from "../../utils/db/prisma.js";
import { randomBytes, randomUUID } from "crypto";
import FormData from "form-data";
import env from "../../env.js";
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
  waitFor,
} from "./utils/test-helpers.js";

const text = (content: string) => createTestFile(content, "a.txt");

/** Flips one byte of a blob file, at `offset` from its end. */
const corruptBlob = async (fsPath: string, fromEnd = 1) => {
  const fh = await open(fsPath, "r+");
  try {
    const { size } = await fh.stat();
    const byte = Buffer.alloc(1);
    await fh.read(byte, 0, 1, size - fromEnd);
    byte[0] ^= 0xff;
    await fh.write(byte, 0, 1, size - fromEnd);
  } finally {
    await fh.close();
  }
};

const currentBlob = (objectId: string) =>
  prisma.objectVersion
    .findFirstOrThrow({
      where: { objectId, isCurrent: true },
      include: { contentBlob: true },
    })
    .then((v) => v.contentBlob!);

const expectJsonErrorHeaders = (headers: Record<string, unknown>) => {
  expect(headers["content-type"]).toMatch(/^application\/json/);
  expect(headers["cache-control"]).toBe("no-store");
  expect(headers["content-disposition"]).toBeUndefined();
  // Express tags the JSON body itself, weakly; the file's tag is strong.
  expect(String(headers.etag ?? "W/")).toMatch(/^W\//);
  expect(headers["last-modified"]).toBeUndefined();
};

describe("download responses", () => {
  let token: string;
  let bucket: { id: number; name: string };
  let objectId: string;
  let firstVersion: { id: string; etag: string | null };
  let current: { id: string; etag: string | null };
  const url = () => `${BASE_URL}/buckets/${bucket.name}/objects/doc.txt`;

  const req = (
    method: "get" | "head",
    target: string,
    headers: Record<string, string> = {},
    params: Record<string, string> = {}
  ) =>
    axios.request({
      method,
      url: target,
      params,
      headers: { Authorization: `Bearer ${token}`, ...headers },
      validateStatus: () => true,
    });

  beforeAll(async () => {
    token = await getTestAccessToken();
    bucket = await createTestBucket(token);
    await axios.put(
      `${BASE_URL}/buckets/${bucket.name}`,
      { versioningEnabled: true },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    objectId = (
      await uploadTestObject(token, bucket.name, "doc.txt", text("first one"))
    ).id;
    await uploadTestObject(
      token,
      bucket.name,
      "doc.txt",
      text("second, longer")
    );
    const versions = await prisma.objectVersion.findMany({
      where: { objectId },
      orderBy: { createdAt: "asc" },
    });
    [firstVersion, current] = versions;
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("errors", () => {
    it("answers 416 as JSON, without the file's headers", async () => {
      const res = await req("get", url(), { Range: "bytes=500-" });
      expect(res.status).toBe(416);
      expect(res.headers["content-range"]).toBe("bytes */14");
      expectJsonErrorHeaders(res.headers);
      expect(res.data.error).toBe("range_not_satisfiable");
    });

    it("answers a failed integrity check as JSON, without the file's headers", async () => {
      const obj = await uploadTestObject(
        token,
        bucket.name,
        "tampered.txt",
        text(`tampered ${randomUUID()}`)
      );
      await corruptBlob((await currentBlob(obj.id)).fsPath);
      const res = await req(
        "get",
        `${BASE_URL}/buckets/${bucket.name}/objects/tampered.txt`
      );
      expect(res.status).toBe(HTTP_STATUS.INTERNAL_SERVER_ERROR);
      expectJsonErrorHeaders(res.headers);
    });

    it("logs a download cut off mid-stream", async () => {
      const big = Buffer.from(randomBytes(8.5 * 1024 * 1024).toString("hex"));
      const obj = await uploadTestObject(token, bucket.name, "big.bin", {
        buffer: big,
        filename: "big.bin",
        contentType: "application/octet-stream",
      });
      // The GCM tag, checked only once the body is out.
      await corruptBlob((await currentBlob(obj.id)).fsPath);
      await axios
        .get(`${BASE_URL}/buckets/${bucket.name}/objects/big.bin`, {
          headers: { Authorization: `Bearer ${token}` },
          responseType: "arraybuffer",
        })
        // The plaintext may all be out before the tag fails: the reset is
        // what the client may or may not notice.
        .catch(() => undefined);
      await waitFor(
        async () =>
          (await prisma.accessLog.count({
            where: {
              objectId: obj.id,
              operation: "DOWNLOAD_OBJECT",
              errorMessage: { not: null },
            },
          })) > 0,
        10_000
      );
    });
  });

  describe("HEAD", () => {
    const compared = [
      "content-type",
      "content-length",
      "etag",
      "last-modified",
      "cache-control",
      "content-disposition",
      "content-security-policy",
      "x-content-type-options",
      "accept-ranges",
      "x-object-id",
    ];

    it("describes the version ?versionId= names, as GET serves it", async () => {
      const params = { versionId: firstVersion.id };
      const get = await req("get", url(), {}, params);
      const head = await req("head", url(), {}, params);
      expect(head.status).toBe(HTTP_STATUS.OK);
      for (const name of compared) {
        expect([name, head.headers[name]]).toEqual([name, get.headers[name]]);
      }
      expect(head.headers.etag).toBe(`"${firstVersion.etag}"`);
      expect(head.headers["content-length"]).toBe("9");
      expect(head.headers["cache-control"]).toContain("immutable");
    });

    it("answers a failed If-Match with 412", async () => {
      const res = await req("head", url(), { "If-Match": '"nope"' });
      expect(res.status).toBe(412);
    });
  });

  describe("preconditions", () => {
    const versionUrl = (versionId: string) =>
      `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}/versions/${versionId}/download`;

    it("answers a version download's If-None-Match with 304 and its validators", async () => {
      const res = await req("get", versionUrl(firstVersion.id), {
        "If-None-Match": `W/"${firstVersion.etag}"`,
      });
      expect(res.status).toBe(304);
      expect(res.headers.etag).toBe(`"${firstVersion.etag}"`);
      expect(res.headers["cache-control"]).toContain("immutable");
      expect(res.headers["last-modified"]).toBeDefined();
    });

    it("answers If-Modified-Since with 304 once nothing changed since", async () => {
      const later = new Date(Date.now() + 60_000).toUTCString();
      for (const target of [url(), versionUrl(firstVersion.id)]) {
        const res = await req("get", target, { "If-Modified-Since": later });
        expect([target, res.status]).toEqual([target, 304]);
        expect(res.headers.etag).toBeDefined();
      }
      const earlier = new Date(0).toUTCString();
      const res = await req("get", url(), { "If-Modified-Since": earlier });
      expect(res.status).toBe(HTTP_STATUS.OK);
    });

    it("lets If-None-Match override If-Modified-Since", async () => {
      const later = new Date(Date.now() + 60_000).toUTCString();
      const res = await req("get", url(), {
        "If-None-Match": '"other"',
        "If-Modified-Since": later,
      });
      expect(res.status).toBe(HTTP_STATUS.OK);
    });

    it("answers If-Unmodified-Since before the last change with 412", async () => {
      const res = await req("get", versionUrl(firstVersion.id), {
        "If-Unmodified-Since": new Date(0).toUTCString(),
      });
      expect(res.status).toBe(412);
      expectJsonErrorHeaders(res.headers);
    });

    it("never matches a weak tag in If-Match", async () => {
      const weak = await req("get", url(), {
        "If-Match": `W/"${current.etag}"`,
      });
      expect(weak.status).toBe(412);
      const strong = await req("get", url(), {
        "If-Match": `"${current.etag}"`,
      });
      expect(strong.status).toBe(HTTP_STATUS.OK);
    });
  });

  describe("PUT preconditions", () => {
    const put = (headers: Record<string, string>) => {
      const form = new FormData();
      form.append("file", Buffer.from(`next ${randomUUID()}`), {
        filename: "a.txt",
        contentType: "text/plain",
      });
      return axios.put(url(), form, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": testIdempotencyKey(),
          ...form.getHeaders(),
          ...headers,
        },
        validateStatus: () => true,
      });
    };

    it("refuses If-None-Match naming the current ETag, weakly compared", async () => {
      const head = await req("head", url());
      const etag = head.headers.etag as string;
      expect((await put({ "If-None-Match": etag })).status).toBe(412);
      expect((await put({ "If-None-Match": `"x", W/${etag}` })).status).toBe(
        412
      );
      expect((await put({ "If-None-Match": '"other"' })).status).toBe(
        HTTP_STATUS.OK
      );
    });

    it("refuses a weak If-Match", async () => {
      const etag = (await req("head", url())).headers.etag as string;
      expect((await put({ "If-Match": `W/${etag}` })).status).toBe(412);
      expect((await put({ "If-Match": etag })).status).toBe(HTTP_STATUS.OK);
    });
  });

  describe("upload staging failures", () => {
    it("answers a temp directory it cannot write with 500, naming no path", async () => {
      // A file where the directory should be: unwritable even as root, which
      // the Docker test stack runs as (a read-only mode would not stop it).
      const tempPath = env.FILE_SERVICE_TEMP_PATH;
      const movedAside = `${tempPath}.moved-aside`;
      await rename(tempPath, movedAside);
      await writeFile(tempPath, "");
      try {
        const form = new FormData();
        form.append("file", Buffer.from("staged"), {
          filename: "a.txt",
          contentType: "text/plain",
        });
        const res = await axios.put(
          `${BASE_URL}/buckets/${bucket.name}/objects/staged.txt`,
          form,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "Idempotency-Key": testIdempotencyKey(),
              ...form.getHeaders(),
            },
            validateStatus: () => true,
          }
        );
        expect(res.status).toBe(HTTP_STATUS.INTERNAL_SERVER_ERROR);
        expect(JSON.stringify(res.data)).not.toContain(
          env.FILE_SERVICE_TEMP_PATH
        );
      } finally {
        await rm(tempPath);
        await rename(movedAside, tempPath);
      }
    });
  });
});

describe("a public bucket's history", () => {
  let token: string;
  let memberToken: string;
  let bucket: { id: number; name: string };
  let liveId: string;
  let liveOld: string;
  let deletedId: string;
  let deletedVersion: string;

  const anon = (target: string, params: Record<string, string> = {}) =>
    axios.get(target, { params, validateStatus: () => true });
  const as = (bearer: string, target: string, params = {}) =>
    axios.get(target, {
      params,
      headers: { Authorization: `Bearer ${bearer}` },
      validateStatus: () => true,
    });
  const objects = () => `${BASE_URL}/buckets/${bucket.name}/objects`;

  beforeAll(async () => {
    token = await getTestAccessToken();
    // Holds the read permission, but no grant on the bucket.
    memberToken = await getTestPrincipalToken({
      permissions: ["file-service.objects.read"],
    });
    bucket = await createTestBucket(token, { policy: "public" });
    await axios.put(
      `${BASE_URL}/buckets/${bucket.name}`,
      { versioningEnabled: true },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    liveId = (
      await uploadTestObject(token, bucket.name, "live.txt", text("v1"))
    ).id;
    await uploadTestObject(token, bucket.name, "live.txt", text("v2 secret"));
    liveOld = (
      await prisma.objectVersion.findFirstOrThrow({
        where: { objectId: liveId, isCurrent: false },
      })
    ).id;

    deletedId = (
      await uploadTestObject(token, bucket.name, "gone.txt", text("removed"))
    ).id;
    deletedVersion = (
      await prisma.objectVersion.findFirstOrThrow({
        where: { objectId: deletedId, isCurrent: true },
      })
    ).id;
    await axios.delete(`${objects()}/by-id/${deletedId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("does not list deleted objects to anyone it is public for", async () => {
    expect((await anon(objects(), { deleted: "true" })).status).toBe(
      HTTP_STATUS.UNAUTHORIZED
    );
    expect((await as(memberToken, objects(), { deleted: "true" })).status).toBe(
      HTTP_STATUS.FORBIDDEN
    );
    const reader = await as(token, objects(), { deleted: "true" });
    expect(reader.status).toBe(HTTP_STATUS.OK);
    expect(reader.data.data.map((o: { id: string }) => o.id)).toContain(
      deletedId
    );
  });

  it("does not serve a deleted object's versions", async () => {
    const versions = `${objects()}/by-id/${deletedId}/versions`;
    for (const target of [
      versions,
      `${versions}/${deletedVersion}`,
      `${versions}/${deletedVersion}/download`,
    ]) {
      expect([target, (await anon(target)).status]).toEqual([
        target,
        HTTP_STATUS.NOT_FOUND,
      ]);
      expect([target, (await as(memberToken, target)).status]).toEqual([
        target,
        HTTP_STATUS.NOT_FOUND,
      ]);
    }
    expect((await as(token, versions)).status).toBe(HTTP_STATUS.OK);
  });

  it("serves only the current version of a live object", async () => {
    const versions = `${objects()}/by-id/${liveId}/versions`;
    const list = await anon(versions);
    expect(list.status).toBe(HTTP_STATUS.OK);
    expect(list.data.data).toHaveLength(1);
    expect(list.data.data[0].isCurrent).toBe(true);

    expect((await anon(`${versions}/${liveOld}/download`)).status).toBe(
      HTTP_STATUS.NOT_FOUND
    );
    expect(
      (await anon(`${objects()}/live.txt`, { versionId: liveOld })).status
    ).toBe(HTTP_STATUS.NOT_FOUND);
    expect((await as(token, `${versions}/${liveOld}/download`)).status).toBe(
      HTTP_STATUS.OK
    );
  });

  it("names no writer, not even by id, to a caller it is public for", async () => {
    const list = await anon(`${objects()}/by-id/${liveId}/versions`);
    expect(list.data.data[0]).toMatchObject({
      createdBy: null,
      createdByEmail: null,
      createdByName: null,
      creator: null,
    });
    const reader = await as(token, `${objects()}/by-id/${liveId}/versions`);
    expect(reader.data.data[0].createdBy).toEqual(expect.any(String));
  });
});
