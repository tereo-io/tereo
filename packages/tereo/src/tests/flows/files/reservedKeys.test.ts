// @module-tag int
// @module-tag files
import { getTestPrincipalToken } from "../../support/principals.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
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
} from "../../support/files.js";

describe("reserved object keys", () => {
  // Keys the objects router answers with its own routes, and where generated
  // thumbnails live. Routes match case-insensitively, so their case variants too.
  const RESERVED = [
    "prefixes",
    "by-id/report.txt",
    "by-key/a/b.txt",
    ".thumbnails/a.png/small",
    "Prefixes",
    "BY-ID/report.txt",
    "By-Key/a/b.txt",
  ];
  let token: string;
  let bucketName: string;

  const as = () => ({
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });

  beforeAll(async () => {
    token = await getTestAccessToken();
    bucketName = (await createTestBucket(token)).name;
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("are refused on upload", async () => {
    for (const key of RESERVED) {
      const form = new FormData();
      form.append("file", Buffer.from("x"), {
        filename: "x.txt",
        contentType: "text/plain",
      });
      const res = await axios.put(
        `${BASE_URL}/buckets/${bucketName}/objects/${key}`,
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
      expect([key, res.status, res.data.error]).toEqual([
        key,
        HTTP_STATUS.BAD_REQUEST,
        "reserved_object_key",
      ]);
    }
  });

  it("are refused on multipart initiate", async () => {
    for (const key of RESERVED) {
      const res = await axios.post(
        `${BASE_URL}/buckets/${bucketName}/multipart`,
        { objectKey: key, contentType: "text/plain" },
        as()
      );
      expect([key, res.status, res.data.error]).toEqual([
        key,
        HTTP_STATUS.BAD_REQUEST,
        "reserved_object_key",
      ]);
    }
  });

  it("are refused only after the access check", async () => {
    // Role permissions to write, but no grant on the bucket.
    const outsider = await getTestPrincipalToken({
      permissions: ["file-service.objects.write"],
    });
    const headers = { Authorization: `Bearer ${outsider}` };

    const initiate = await axios.post(
      `${BASE_URL}/buckets/${bucketName}/multipart`,
      { objectKey: "prefixes", contentType: "text/plain" },
      { headers, validateStatus: () => true }
    );
    expect(initiate.status).toBe(HTTP_STATUS.FORBIDDEN);

    const form = new FormData();
    form.append("file", Buffer.from("x"), {
      filename: "x.txt",
      contentType: "text/plain",
    });
    const upload = await axios.put(
      `${BASE_URL}/buckets/${bucketName}/objects/prefixes`,
      form,
      {
        headers: {
          ...headers,
          "Idempotency-Key": testIdempotencyKey(),
          ...form.getHeaders(),
        },
        validateStatus: () => true,
      }
    );
    expect(upload.status).toBe(HTTP_STATUS.FORBIDDEN);

    const object = await uploadTestObject(
      token,
      bucketName,
      "outsider-rename.txt",
      createTestFile("x", "outsider-rename.txt", "text/plain")
    );
    const rename = await axios.patch(
      `${BASE_URL}/buckets/${bucketName}/objects/by-id/${object.id}`,
      { objectKey: "prefixes" },
      { headers, validateStatus: () => true }
    );
    expect(rename.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("are refused as a rename target", async () => {
    const object = await uploadTestObject(
      token,
      bucketName,
      "rename-me.txt",
      createTestFile("x", "rename-me.txt", "text/plain")
    );
    for (const key of RESERVED) {
      const res = await axios.patch(
        `${BASE_URL}/buckets/${bucketName}/objects/by-id/${object.id}`,
        { objectKey: key },
        as()
      );
      expect([key, res.status, res.data.error]).toEqual([
        key,
        HTTP_STATUS.BAD_REQUEST,
        "reserved_object_key",
      ]);
    }
  });

  it("leave near misses alone", async () => {
    for (const key of [
      "prefixes.txt",
      "by-id",
      "docs/by-id/x.txt",
      ".thumbnails",
      "docs/.thumbnails/x.txt",
      ".Thumbnails/x.txt",
    ]) {
      const object = await uploadTestObject(
        token,
        bucketName,
        key,
        createTestFile("x", "x.txt", "text/plain")
      );
      expect(object.key).toBe(key);
    }
  });

  it("are refused on presigned writes to an object already under one", async () => {
    const object = await uploadTestObject(
      token,
      bucketName,
      "legacy.txt",
      createTestFile("x", "legacy.txt", "text/plain")
    );
    const presignUrl = `${BASE_URL}/buckets/${bucketName}/objects/by-id/${object.id}/presign`;
    const minted = await axios.post<{ url: string }>(
      presignUrl,
      { operation: "write", expiresInSeconds: 60 },
      as()
    );
    expect(minted.status).toBe(HTTP_STATUS.OK);

    // An object stored under a reserved key before keys were reserved.
    await prisma.object.update({
      where: { id: object.id },
      data: { objectKey: "prefixes" },
    });

    const write = await axios.post(
      presignUrl,
      { operation: "write", expiresInSeconds: 60 },
      as()
    );
    expect(write.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(write.data.error).toBe("reserved_object_key");

    const read = await axios.post(
      presignUrl,
      { operation: "read", expiresInSeconds: 60 },
      as()
    );
    expect(read.status).toBe(HTTP_STATUS.OK);

    const put = await axios.put(minted.data.url, Buffer.from("second"), {
      headers: { "Content-Type": "text/plain" },
      validateStatus: () => true,
    });
    expect(put.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(put.data.error).toBe("reserved_object_key");
  });
});
