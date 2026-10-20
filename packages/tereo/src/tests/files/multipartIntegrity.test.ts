import { multipartCompleteClaim } from "../../routes/v1/files/buckets/bucket/multipart/utils.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRedisClient, redisKey } from "../../utils/redis.js";
import { prisma } from "../../utils/db/prisma.js";
import { PassThrough, Readable } from "stream";
import db from "../../utils/db/index.js";
import { randomBytes } from "crypto";
import env from "../../env.js";
import fs from "fs/promises";
import axios from "axios";
import path from "path";
import {
  aadForPart,
  createMultipartPartDecryptStream,
  createMultipartPartEncryptStream,
} from "../../utils/encryption.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  getTestAccessToken,
  grantTestPermission,
  testIdempotencyKey,
  waitFor,
} from "./utils/test-helpers.js";
import {
  FIXTURE_USER_IDS,
  getTestPrincipalToken,
} from "../utils/principals.js";

const MIN_PART = env.FILE_SERVICE_MIN_PART_SIZE_MB * 1024 * 1024;

// Content a complete's file-type check accepts, as random bytes may not be.
const text = () => Buffer.from(`part ${randomBytes(16).toString("hex")}`);

describe("multipart write integrity", () => {
  let token: string;
  let bucketName: string;

  const as = (t = token) => ({
    headers: { Authorization: `Bearer ${t}` },
    validateStatus: () => true,
  });

  const initiate = async (t = token) => {
    const res = await axios.post(
      `${BASE_URL}/buckets/${bucketName}/multipart`,
      {
        objectKey: `mp-${randomBytes(4).toString("hex")}.bin`,
        contentType: "application/octet-stream",
      },
      as(t)
    );
    expect(res.status).toBe(HTTP_STATUS.CREATED);
    return res.data.uploadId as string;
  };

  const putPart = (
    uploadId: string,
    partNumber: number,
    body: Buffer | Readable
  ) =>
    axios.put(
      `${BASE_URL}/buckets/${bucketName}/multipart/${uploadId}/parts/${partNumber}`,
      body,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
        },
        validateStatus: () => true,
        maxBodyLength: Infinity,
      }
    );

  const complete = (
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>
  ) =>
    axios.post(
      `${BASE_URL}/buckets/${bucketName}/multipart/${uploadId}/complete`,
      { parts },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": testIdempotencyKey(),
        },
        validateStatus: () => true,
      }
    );

  const uploadDir = (uploadId: string) =>
    path.join(env.FILE_SERVICE_STORAGE_PATH, "multipart", uploadId);

  const stagedFiles = (uploadId: string) =>
    fs.readdir(uploadDir(uploadId)).catch(() => [] as string[]);

  // A part PUT whose body is held open until `finish`, once the server is
  // staging it.
  const heldPart = async (uploadId: string, partNumber: number) => {
    const before = (await stagedFiles(uploadId)).length;
    const body = new PassThrough();
    const response = putPart(uploadId, partNumber, body);
    body.write(randomBytes(1024));
    await waitFor(
      async () => (await stagedFiles(uploadId)).length > before,
      10_000
    );
    return {
      finish: async () => {
        body.end(randomBytes(1024));
        return await response;
      },
    };
  };

  // Re-encrypts a staged part as it was staged before parts were bound.
  const unbindPart = async (uploadId: string, partNumber: number) => {
    const upload = await db.multipartUploads.getAny(uploadId);
    const dek = db.multipartUploads.unwrapStagingDek(upload);
    const part = await prisma.multipartPart.findUniqueOrThrow({
      where: { uploadId_partNumber: { uploadId, partNumber } },
    });
    const chunks: Buffer[] = [];
    for await (const chunk of Readable.from([
      await fs.readFile(part.fsPath),
    ]).pipe(
      createMultipartPartDecryptStream(dek, aadForPart(uploadId, partNumber))
    )) {
      chunks.push(chunk as Buffer);
    }
    const legacy: Buffer[] = [];
    // An empty AAD is what GCM authenticates when none is set.
    for await (const chunk of Readable.from([Buffer.concat(chunks)]).pipe(
      createMultipartPartEncryptStream(dek, Buffer.alloc(0))
    )) {
      legacy.push(chunk as Buffer);
    }
    await fs.writeFile(part.fsPath, Buffer.concat(legacy));
    await prisma.multipartPart.update({
      where: { id: part.id },
      data: { aadBound: false },
    });
    return part;
  };

  const swapPartFiles = async (uploadId: string) => {
    const [one, two] = await prisma.multipartPart.findMany({
      where: { uploadId },
      orderBy: { partNumber: "asc" },
    });
    await prisma.multipartPart.update({
      where: { id: one.id },
      data: { fsPath: two.fsPath },
    });
    await prisma.multipartPart.update({
      where: { id: two.id },
      data: { fsPath: one.fsPath },
    });
  };

  const twoParts = async () => {
    const uploadId = await initiate();
    const first = await putPart(uploadId, 1, randomBytes(MIN_PART));
    const second = await putPart(uploadId, 2, randomBytes(MIN_PART));
    expect([first.status, second.status]).toEqual([200, 200]);
    return {
      uploadId,
      parts: [
        { partNumber: 1, etag: first.data.etag as string },
        { partNumber: 2, etag: second.data.etag as string },
      ],
    };
  };

  beforeAll(async () => {
    token = await getTestAccessToken();
    bucketName = (await createTestBucket(token)).name;
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("refuses a part whose upload was aborted while it was staged", async () => {
    const uploadId = await initiate();
    const held = await heldPart(uploadId, 1);

    const abort = await axios.delete(
      `${BASE_URL}/buckets/${bucketName}/multipart/${uploadId}`,
      as()
    );
    expect(abort.status).toBe(HTTP_STATUS.NO_CONTENT);

    const res = await held.finish();
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.data.error).toBe("upload_not_active");
    expect(await prisma.multipartPart.count({ where: { uploadId } })).toBe(0);
    await expect(fs.access(uploadDir(uploadId))).rejects.toThrow();
  });

  it("refuses a part whose upload was completed while it was staged", async () => {
    const uploadId = await initiate();
    const first = await putPart(uploadId, 1, text());
    const held = await heldPart(uploadId, 2);

    const done = await complete(uploadId, [
      { partNumber: 1, etag: first.data.etag },
    ]);
    expect(done.status).toBe(HTTP_STATUS.CREATED);

    const res = await held.finish();
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.data.error).toBe("upload_not_active");
    expect(await prisma.multipartPart.count({ where: { uploadId } })).toBe(0);
  });

  it("refuses a part while a complete of the upload runs", async () => {
    const uploadId = await initiate();
    const first = await putPart(uploadId, 1, text());
    const claim = redisKey(multipartCompleteClaim(uploadId));
    await getRedisClient().set(claim, "held-by-test", "EX", 60);
    try {
      const res = await putPart(uploadId, 1, text());
      expect(res.status).toBe(HTTP_STATUS.CONFLICT);
      expect(res.data.error).toBe("multipart_complete_in_progress");
      const [part] = await prisma.multipartPart.findMany({
        where: { uploadId },
      });
      expect(part.etag).toBe(first.data.etag);
      expect(await stagedFiles(uploadId)).toHaveLength(1);
    } finally {
      await getRedisClient().del(claim);
    }
  });

  it("refuses to complete with a part file moved to another part", async () => {
    const { uploadId, parts } = await twoParts();
    await swapPartFiles(uploadId);
    const res = await complete(uploadId, parts);
    expect(res.status).toBe(422);
    expect(res.data.error).toBe("part_integrity_mismatch");
    expect(
      await prisma.multipartUpload.findUniqueOrThrow({
        where: { id: uploadId },
      })
    ).toMatchObject({ completedAt: null });
  });

  it("refuses to complete with unbound parts whose contents were swapped", async () => {
    const { uploadId, parts } = await twoParts();
    await unbindPart(uploadId, 1);
    await unbindPart(uploadId, 2);
    await swapPartFiles(uploadId);
    const res = await complete(uploadId, parts);
    expect(res.status).toBe(422);
    expect(res.data.error).toBe("part_integrity_mismatch");
  });

  it("completes an upload with a part staged before parts were bound", async () => {
    const uploadId = await initiate();
    const content = Buffer.from(`legacy ${randomBytes(8).toString("hex")}`);
    const put = await putPart(uploadId, 1, content);
    await unbindPart(uploadId, 1);

    const res = await complete(uploadId, [
      { partNumber: 1, etag: put.data.etag },
    ]);
    expect(res.status).toBe(HTTP_STATUS.CREATED);
    const download = await axios.get(
      `${BASE_URL}/buckets/${bucketName}/objects/${res.data.key}`,
      { ...as(), responseType: "arraybuffer" }
    );
    expect(Buffer.from(download.data).equals(content)).toBe(true);
  });

  it("audits the object a complete writes, as an upload does", async () => {
    const uploadId = await initiate();
    const put = await putPart(uploadId, 1, text());
    const created = await complete(uploadId, [
      { partNumber: 1, etag: put.data.etag },
    ]);
    expect(created.status).toBe(HTTP_STATUS.CREATED);
    const entry = await prisma.auditLogEntry.findFirst({
      where: { entityType: "object", entityId: created.data.id },
    });
    expect(entry).toMatchObject({
      action: "CREATE",
      entityName: created.data.key,
    });
    expect(entry?.metadata).toMatchObject({ multipartUploadId: uploadId });
  });

  it("lists an upload's parts only for the user who initiated it", async () => {
    const uploadId = await initiate();
    await putPart(uploadId, 1, text());
    const otherId = FIXTURE_USER_IDS[2];
    await grantTestPermission(token, bucketName, otherId, { canRead: true });
    const other = await getTestPrincipalToken({
      userId: otherId,
      permissions: ["file-service.objects.read"],
    });

    const url = `${BASE_URL}/buckets/${bucketName}/multipart/${uploadId}`;
    const refused = await axios.get(url, as(other));
    expect(refused.status).toBe(HTTP_STATUS.FORBIDDEN);
    const own = await axios.get(url, as());
    expect(own.status).toBe(HTTP_STATUS.OK);
    expect(own.data.parts).toHaveLength(1);
  });
});
