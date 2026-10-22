// @module-tag int
// @module-tag files
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { open, rename, rm, writeFile } from "fs/promises";
import { randomBytes, randomUUID } from "crypto";
import env from "../../../../../../../../env.js";
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
  waitFor,
} from "../../../../../../../support/files.js";

describe("GET and PUT /v1/files/buckets/:name/objects/*objectKey", () => {
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
  let token: string;
  let bucket: { id: number; name: string };
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
    await uploadTestObject(
      token,
      bucket.name,
      "doc.txt",
      text("second, longer")
    );
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
