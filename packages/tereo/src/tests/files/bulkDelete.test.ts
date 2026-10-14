import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObject,
} from "./utils/test-helpers.js";

describe("Bulk deletes", () => {
  let token: string;
  const auth = () => ({
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  const keys = async (bucketName: string) => {
    const res = await axios.get(
      `${BASE_URL}/buckets/${bucketName}/objects`,
      auth()
    );
    return res.data.data.map((o: { key: string }) => o.key).sort();
  };

  it("deletes by prefix and by id, with one audit entry each", async () => {
    const bucket = await createTestBucket(token);
    for (const key of ["a/1.txt", "a/2.txt", "a/b/3.txt"]) {
      await uploadTestObject(
        token,
        bucket.name,
        key,
        createTestFile(`${key} ${randomUUID()}`)
      );
    }
    const keep = await uploadTestObject(
      token,
      bucket.name,
      "b/keep.txt",
      createTestFile(`keep ${randomUUID()}`)
    );
    const url = `${BASE_URL}/buckets/${bucket.name}/objects/bulk-delete`;

    const byPrefix = await axios.post(url, { prefix: "a/" }, auth());
    expect(byPrefix.status).toBe(HTTP_STATUS.OK);
    expect(byPrefix.data).toEqual({ deletedCount: 3, truncated: false });
    expect(await keys(bucket.name)).toEqual(["b/keep.txt"]);

    const byId = await axios.post(url, { ids: [keep.id] }, auth());
    expect(byId.data).toEqual({ deletedCount: 1, truncated: false });
    expect(await keys(bucket.name)).toEqual([]);

    const entries = await prisma.auditLogEntry.findMany({
      where: { entityType: "objects_bulk", entityId: String(bucket.id) },
    });
    expect(entries).toHaveLength(2);
  });

  it("refuses an empty prefix and a body with both forms", async () => {
    const bucket = await createTestBucket(token);
    const url = `${BASE_URL}/buckets/${bucket.name}/objects/bulk-delete`;
    for (const body of [{ prefix: "" }, { prefix: "a/", ids: [] }, {}]) {
      const res = await axios.post(url, body, auth());
      expect([body, res.status]).toEqual([body, HTTP_STATUS.BAD_REQUEST]);
    }
  });

  it("purges non-current versions and keeps the current one", async () => {
    const v2 = `v2 ${randomUUID()}`;
    const bucket = await createTestBucket(token);
    await axios.put(
      `${BASE_URL}/buckets/${bucket.name}`,
      { versioningEnabled: true },
      auth()
    );
    await uploadTestObject(
      token,
      bucket.name,
      "doc.txt",
      createTestFile(`v1 ${randomUUID()}`)
    );
    const object = await uploadTestObject(
      token,
      bucket.name,
      "doc.txt",
      createTestFile(v2)
    );

    const res = await axios.post(
      `${BASE_URL}/buckets/${bucket.name}/objects/purge-non-current-versions`,
      {},
      auth()
    );
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(res.data).toMatchObject({ purgedCount: 1, truncated: false });

    const versions = await axios.get(
      `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${object.id}/versions`,
      auth()
    );
    expect(versions.data.data).toHaveLength(1);
    expect(versions.data.data[0].isCurrent).toBe(true);
    const download = await axios.get(
      `${BASE_URL}/buckets/${bucket.name}/objects/doc.txt`,
      auth()
    );
    expect(download.data).toBe(v2);
  });
});
