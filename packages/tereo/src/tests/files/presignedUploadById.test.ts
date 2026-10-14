import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import http from "http";
import {
  BASE_URL,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObject,
} from "./utils/test-helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("presigned write to an object changed while its body streams", () => {
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

  const presignWrite = async (bucketName: string, objectId: string) => {
    const presign = await axios.post<{ url: string }>(
      `${BASE_URL}/buckets/${bucketName}/objects/by-id/${objectId}/presign`,
      { operation: "write", expiresInSeconds: 300 },
      auth()
    );
    expect(presign.status).toBe(200);
    return new URL(presign.data.url);
  };

  // Sends the first bytes, runs `meanwhile` once the handler is reading the
  // body, then sends the rest.
  const putInTwoParts = (
    url: URL,
    body: string,
    meanwhile: () => Promise<void>
  ) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        url,
        {
          method: "PUT",
          headers: {
            "Content-Type": "text/plain",
            "Transfer-Encoding": "chunked",
          },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (data += c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: data })
          );
        }
      );
      req.on("error", reject);
      req.write(body.slice(0, 4));
      (async () => {
        await sleep(500);
        await meanwhile();
        req.end(body.slice(4));
      })().catch(reject);
    });

  it("writes to the signed object under its new key, not to the object that took its old key", async () => {
    const bucket = await createTestBucket(token);
    const cBody = `C ${randomUUID()}`;
    const a = await uploadTestObject(
      token,
      bucket.name,
      "a.txt",
      createTestFile(`A ${randomUUID()}`)
    );
    const c = await uploadTestObject(
      token,
      bucket.name,
      "c.txt",
      createTestFile(cBody)
    );
    const url = await presignWrite(bucket.name, a.id);

    const written = `new ${randomUUID()}`;
    const res = await putInTwoParts(url, written, async () => {
      const r1 = await axios.patch(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${a.id}`,
        { objectKey: "b.txt" },
        auth()
      );
      const r2 = await axios.patch(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${c.id}`,
        { objectKey: "a.txt" },
        auth()
      );
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id: a.id, key: "b.txt" });

    const cDownload = await axios.get(
      `${BASE_URL}/buckets/${bucket.name}/objects/a.txt`,
      { ...auth(), responseType: "text" }
    );
    expect(cDownload.headers["x-object-id"]).toBe(c.id);
    expect(cDownload.data).toBe(cBody);

    const aDownload = await axios.get(
      `${BASE_URL}/buckets/${bucket.name}/objects/b.txt`,
      { ...auth(), responseType: "text" }
    );
    expect(aDownload.headers["x-object-id"]).toBe(a.id);
    expect(aDownload.data).toBe(written);
  });

  it("answers 404 and creates nothing when the object is deleted meanwhile", async () => {
    const bucket = await createTestBucket(token);
    const a = await uploadTestObject(
      token,
      bucket.name,
      "a.txt",
      createTestFile(`A ${randomUUID()}`)
    );
    const url = await presignWrite(bucket.name, a.id);

    const res = await putInTwoParts(url, `new ${randomUUID()}`, async () => {
      const del = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${a.id}`,
        auth()
      );
      expect(del.status).toBe(204);
    });
    expect(res.status).toBe(404);

    const live = await prisma.object.count({
      where: { bucketId: bucket.id, objectKey: "a.txt", deletedAt: null },
    });
    expect(live).toBe(0);
  });
});
