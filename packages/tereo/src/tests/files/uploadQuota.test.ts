import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { randomBytes, randomUUID } from "crypto";
import db from "../../utils/db/index.js";
import FormData from "form-data";
import axios from "axios";
import http from "http";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  testIdempotencyKey,
  uploadTestObject,
} from "../support/files.js";

describe("upload quota", () => {
  let token: string;

  const as = () => ({
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });

  const put = (
    bucketName: string,
    key: string,
    size: number,
    idempotencyKey = testIdempotencyKey()
  ) => {
    const form = new FormData();
    form.append("file", Buffer.from("x".repeat(size)), {
      filename: "q.txt",
      contentType: "text/plain",
    });
    return axios.put(`${BASE_URL}/buckets/${bucketName}/objects/${key}`, form, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": idempotencyKey,
        ...form.getHeaders(),
      },
      validateStatus: () => true,
    });
  };

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("refuses an upload whose Content-Length passes the quota before reading its body", async () => {
    const bucket = await createTestBucket(token, { storageQuotaBytes: "1000" });
    const url = new URL(`${BASE_URL}/buckets/${bucket.name}/objects/big.txt`);

    // Declares a megabyte but sends a few bytes and holds the rest back: only
    // a refusal made before the body is read can answer.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": testIdempotencyKey(),
          "Content-Type": "multipart/form-data; boundary=held",
          "Content-Length": String(1024 * 1024),
        },
      });
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error("No answer before the body was sent"));
      }, 5_000);
      req.on("response", (res) => {
        clearTimeout(timer);
        res.resume();
        req.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      req.write("--held\r\n");
    });
    expect(status).toBe(HTTP_STATUS.INSUFFICIENT_STORAGE);
  });

  it("lets an overwrite in a bucket without versioning count the bytes it frees", async () => {
    const bucket = await createTestBucket(token, { storageQuotaBytes: "5000" });
    expect((await put(bucket.name, "same.txt", 4000)).status).toBe(
      HTTP_STATUS.CREATED
    );
    expect((await put(bucket.name, "same.txt", 4000)).status).toBe(
      HTTP_STATUS.OK
    );
    const other = await put(bucket.name, "other.txt", 4000);
    expect(other.status).toBe(HTTP_STATUS.INSUFFICIENT_STORAGE);
  });

  it("replays a retry of the upload that filled the bucket", async () => {
    const bucket = await createTestBucket(token, { storageQuotaBytes: "5000" });
    const key = testIdempotencyKey();
    const first = await put(bucket.name, "full.txt", 4000, key);
    expect(first.status).toBe(HTTP_STATUS.CREATED);
    const retry = await put(bucket.name, "full.txt", 4000, key);
    expect(retry.status).toBe(HTTP_STATUS.CREATED);
    expect(retry.headers["idempotency-replay"]).toBe("true");
  });

  it("keeps the room an active multipart upload holds from other writes", async () => {
    const bucket = await createTestBucket(token, { storageQuotaBytes: "2000" });
    const init = await axios.post(
      `${BASE_URL}/buckets/${bucket.name}/multipart`,
      {
        objectKey: "reserved.txt",
        contentType: "text/plain",
        expectedSize: 1500,
      },
      as()
    );
    expect(init.status).toBe(HTTP_STATUS.CREATED);
    const { uploadId } = init.data;

    const direct = await put(bucket.name, "squeeze.txt", 600);
    expect(direct.status).toBe(HTTP_STATUS.INSUFFICIENT_STORAGE);

    // The authoritative check in the write's transaction, without the early
    // one: refused by the reservation, admitted for the reserving upload.
    const reserve = (completingUploadId?: string) =>
      prisma.$transaction(async (tx) => {
        await db.buckets.reserveQuota(bucket.id, 600n, tx, completingUploadId);
        throw new Error("rolled back");
      });
    await expect(reserve()).rejects.toMatchObject({
      code: "insufficient_storage",
    });
    await expect(reserve(uploadId)).rejects.toThrow("rolled back");

    const part = await axios.put(
      `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}/parts/1`,
      Buffer.from("y".repeat(1500)),
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
        },
        validateStatus: () => true,
      }
    );
    expect(part.status).toBe(HTTP_STATUS.OK);
    const done = await axios.post(
      `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}/complete`,
      { parts: [{ partNumber: 1, etag: part.data.etag }] },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": randomUUID(),
        },
        validateStatus: () => true,
      }
    );
    expect(done.status).toBe(HTTP_STATUS.CREATED);

    // The reservation ended with the upload; the bytes are usage now.
    const small = await uploadTestObject(
      token,
      bucket.name,
      "fits.txt",
      createTestFile(randomBytes(4).toString("hex"))
    );
    expect(small.key).toBe("fits.txt");
  });
});
