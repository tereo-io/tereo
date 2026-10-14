import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateStagingDek } from "../../utils/encryption.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import fs from "node:fs/promises";
import env from "../../env.js";
import path from "node:path";
import axios from "axios";
import {
  processMultipartSweepTick,
  sweepTempFiles,
} from "../../jobs/multipartSweep.js";
import {
  BASE_URL,
  cleanupTestEntities,
  createTestBucket,
  getTestAccessToken,
} from "./utils/test-helpers.js";

describe("multipartSweep worker", () => {
  let token: string;

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("is a no-op when no uploads are expired (happy path)", async () => {
    await expect(processMultipartSweepTick()).resolves.toMatchObject({
      processed: expect.any(Number),
    });
  });

  it("refuses parts for an upload past its expiry before the sweep runs", async () => {
    const bucket = await createTestBucket(token, { policy: "private" });
    const init = await axios.post(
      `${BASE_URL}/buckets/${bucket.name}/multipart`,
      { objectKey: "late.bin", contentType: "application/octet-stream" },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const uploadId = init.data.uploadId as string;
    await prisma.multipartUpload.update({
      where: { id: uploadId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const part = await axios.put(
      `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}/parts/1`,
      Buffer.from("late"),
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
        },
        validateStatus: () => true,
      }
    );
    expect(part.status).toBe(404);
  });

  it("aborts expired multipart uploads (error path surrogate)", async () => {
    const bucket = await createTestBucket(token, { policy: "private" });

    // Seed an expired, still-active multipart upload directly (bypassing
    // the HTTP initiate path so we can set expiresAt in the past).
    const id = uuidv7();
    const { wrapped, masterKeyVersion } = generateStagingDek(id);
    const upload = await prisma.multipartUpload.create({
      data: {
        id,
        bucketId: bucket.id,
        objectKey: "expired.bin",
        contentType: "application/octet-stream",
        createdBy: "00000000-0000-7001-0000-000000000001",
        expiresAt: new Date(Date.now() - 60_000),
        wrappedStagingDek: new Uint8Array(wrapped),
        stagingDekMasterKeyVersion: masterKeyVersion,
      },
    });

    await expect(processMultipartSweepTick()).resolves.toMatchObject({
      processed: expect.any(Number),
    });

    const after = await prisma.multipartUpload.findUnique({
      where: { id: upload.id },
    });
    expect(after?.abortedAt).not.toBeNull();
  });

  it("removes temp files a crash left behind, and only old ones", async () => {
    await fs.mkdir(env.FILE_SERVICE_TEMP_PATH, { recursive: true });
    const name = () =>
      path.join(
        env.FILE_SERVICE_TEMP_PATH,
        `upload-${randomBytes(12).toString("hex")}`
      );
    const stale = name();
    const fresh = name();
    // Not one of core's: the directory may be shared.
    const foreign = path.join(
      env.FILE_SERVICE_TEMP_PATH,
      `someone-elses-${randomBytes(4).toString("hex")}.txt`
    );
    await fs.writeFile(stale, "stale");
    await fs.writeFile(fresh, "fresh");
    await fs.writeFile(foreign, "foreign");
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(stale, twoDaysAgo, twoDaysAgo);
    await fs.utimes(foreign, twoDaysAgo, twoDaysAgo);

    try {
      expect(await sweepTempFiles()).toBeGreaterThanOrEqual(1);
      await expect(fs.access(stale)).rejects.toThrow();
      await expect(fs.access(fresh)).resolves.toBeUndefined();
      await expect(fs.access(foreign)).resolves.toBeUndefined();
    } finally {
      await fs.rm(stale, { force: true });
      await fs.rm(fresh, { force: true });
      await fs.rm(foreign, { force: true });
    }
  });
});
