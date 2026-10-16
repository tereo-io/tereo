import { downloadCsp } from "../../routes/v1/files/buckets/bucket/objects/utils.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { createHash, randomUUID } from "crypto";
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

// A browser takes the last type of a list: this renders as HTML.
const SMUGGLED = "image/png, text/html";
const SANDBOX = "sandbox; default-src 'none'";
const NO_SANDBOX = "default-src 'none'";

describe("object content types", () => {
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

  const uploaded = async (key = "f.txt") => {
    const bucket = await createTestBucket(token);
    const obj = await uploadTestObject(
      token,
      bucket.name,
      key,
      createTestFile(`body ${randomUUID()}`, key, "text/plain")
    );
    return { bucket, obj };
  };

  it("PATCH refuses a list of types and normalizes a charset", async () => {
    const { bucket, obj } = await uploaded();
    const url = `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}`;

    const smuggled = await axios.patch(url, { contentType: SMUGGLED }, auth());
    expect(smuggled.status).toBe(HTTP_STATUS.BAD_REQUEST);

    const param = await axios.patch(
      url,
      { contentType: "text/plain; boundary=x" },
      auth()
    );
    expect(param.status).toBe(HTTP_STATUS.BAD_REQUEST);

    const ok = await axios.patch(
      url,
      { contentType: "Text/Plain; Charset=UTF-8" },
      auth()
    );
    expect(ok.status).toBe(HTTP_STATUS.OK);
    expect(ok.data.contentType).toBe("text/plain; charset=utf-8");
  });

  it("multipart initiate refuses a list of types", async () => {
    const bucket = await createTestBucket(token);
    const res = await axios.post(
      `${BASE_URL}/buckets/${bucket.name}/multipart`,
      { objectKey: "m.bin", contentType: SMUGGLED },
      auth()
    );
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });

  it("a presigned upload refuses a list of types", async () => {
    const { bucket, obj } = await uploaded();
    const presign = await axios.post(
      `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}/presign`,
      { operation: "write", expiresInSeconds: 60 },
      auth()
    );
    expect(presign.status).toBe(HTTP_STATUS.OK);

    const res = await axios.put(presign.data.url, "<script>1</script>", {
      headers: { "Content-Type": SMUGGLED },
      validateStatus: () => true,
    });
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.data.error).toBe("invalid_content_type");
  });

  it("serves a stored list of types as an attachment, sandboxed", async () => {
    const { bucket, obj } = await uploaded("x.png");
    await prisma.objectVersion.updateMany({
      where: { objectId: obj.id, isCurrent: true },
      data: { contentType: SMUGGLED },
    });

    const res = await axios.get(
      `${BASE_URL}/buckets/${bucket.name}/objects/x.png`,
      auth()
    );
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(res.headers["content-security-policy"]).toBe(SANDBOX);
  });

  it("sandboxes signed downloads too", async () => {
    const { bucket, obj } = await uploaded();
    const presign = await axios.post(
      `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}/presign`,
      { operation: "read", expiresInSeconds: 60 },
      auth()
    );
    const res = await axios.get(presign.data.url, {
      validateStatus: () => true,
    });
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(res.headers["content-security-policy"]).toBe(SANDBOX);
  });

  it("serves an inline PDF without the sandbox directive", async () => {
    const { bucket, obj } = await uploaded("a.pdf");
    await prisma.objectVersion.updateMany({
      where: { objectId: obj.id, isCurrent: true },
      data: { contentType: "application/pdf" },
    });

    const res = await axios.get(
      `${BASE_URL}/buckets/${bucket.name}/objects/a.pdf`,
      auth()
    );
    expect(res.headers["content-disposition"]).toMatch(/^inline;/);
    expect(res.headers["content-security-policy"]).toBe(NO_SANDBOX);

    const presign = await axios.post(
      `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}/presign`,
      { operation: "read", expiresInSeconds: 60 },
      auth()
    );
    const signed = await axios.get(presign.data.url, {
      validateStatus: () => true,
    });
    expect(signed.headers["content-disposition"]).toMatch(/^inline;/);
    expect(signed.headers["content-security-policy"]).toBe(NO_SANDBOX);
  });

  it("downloadCsp keeps the sandbox for everything but inline PDFs", () => {
    expect(downloadCsp("application/pdf", true)).toBe(NO_SANDBOX);
    expect(downloadCsp("application/pdf; charset=binary", true)).toBe(
      NO_SANDBOX
    );
    expect(downloadCsp("application/pdf", false)).toBe(SANDBOX);
    expect(downloadCsp("application/pdf, text/html", true)).toBe(SANDBOX);
    expect(downloadCsp("image/png", true)).toBe(SANDBOX);
    expect(downloadCsp("text/plain", true)).toBe(SANDBOX);
    expect(downloadCsp("application/zip", false)).toBe(SANDBOX);
  });

  it("checks a completed multipart upload's content against the blocklist", async () => {
    const bucket = await createTestBucket(token);
    const init = await axios.post(
      `${BASE_URL}/buckets/${bucket.name}/multipart`,
      { objectKey: "tool.bin", contentType: "application/octet-stream" },
      auth()
    );
    expect(init.status).toBe(HTTP_STATUS.CREATED);
    const uploadId = init.data.uploadId as string;

    // "MZ": a Windows executable's magic bytes.
    const body = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(256)]);
    const part = await axios.put(
      `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}/parts/1`,
      body,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
        },
      }
    );
    expect(part.data.etag).toBe(createHash("md5").update(body).digest("hex"));

    const complete = await axios.post(
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
    expect(complete.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(complete.data.error).toBe("blocked_file_type");
    expect(await prisma.object.count({ where: { bucketId: bucket.id } })).toBe(
      0
    );
  });
});
