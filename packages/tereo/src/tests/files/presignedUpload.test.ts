import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sign, verify } from "../../utils/presigning.js";
import { prisma } from "../../utils/db/prisma.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  getTestUserId,
  uploadTestObject,
} from "./utils/test-helpers.js";

const ID = "018ebd2a-b2b3-7d1c-a7c2-3e3f9a1c8d00";
const USER = "00000000-0000-7001-8000-000000000001";

describe("presigned URL signer", () => {
  const signed = () =>
    new URL(
      sign({
        bucket: "b",
        id: ID,
        operation: "write",
        expiresInSeconds: 60,
        by: USER,
      }).url
    ).searchParams;

  const verifyWith = (params: URLSearchParams, by: string | null) =>
    verify({
      bucket: "b",
      id: ID,
      operation: "write",
      expires: params.get("expires")!,
      nonce: params.get("nonce")!,
      v: params.get("v")!,
      sig: params.get("sig")!,
      by,
    });

  it("carries the signer and binds it into the signature", () => {
    const params = signed();
    expect(params.get("by")).toBe(USER);
    expect(verifyWith(params, params.get("by")).by).toBe(USER);
  });

  it("rejects a URL whose signer was stripped or swapped", () => {
    const params = signed();
    expect(() => verifyWith(params, null)).toThrow();
    expect(() =>
      verifyWith(params, "00000000-0000-7001-8000-000000000002")
    ).toThrow();
  });
});

describe("PUT through a presigned write URL", () => {
  let token: string;

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("stores the upload with the signer as createdBy", async () => {
    const bucket = await createTestBucket(token);
    const original = await uploadTestObject(
      token,
      bucket.name,
      "presigned.txt",
      createTestFile("first", "presigned.txt", "text/plain")
    );

    const presign = await axios.post<{ url: string }>(
      `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${original.id}/presign`,
      { operation: "write", expiresInSeconds: 60 },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(new URL(presign.data.url).searchParams.get("by")).toBe(
      getTestUserId()
    );

    const put = await axios.put(presign.data.url, Buffer.from("second"), {
      headers: { "Content-Type": "text/plain" },
      validateStatus: () => true,
    });
    expect([HTTP_STATUS.OK, HTTP_STATUS.CREATED]).toContain(put.status);

    const row = await prisma.object.findUniqueOrThrow({
      where: { id: original.id },
    });
    expect(row.createdBy).toBe(getTestUserId());
  });
});
