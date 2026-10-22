// @module-tag int
// @module-tag files
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import axios from "axios";
import {
  BASE_URL as FILES_URL,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObjectAndGetId,
} from "../../../../../../../../../support/files.js";

describe("POST /v1/files/buckets/:name/objects/by-id/:id/presign", () => {
  let token: string;

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("points presigned URLs under /v1/files", async () => {
    const bucket = await createTestBucket(token);
    const file = createTestFile("hello", "hello.txt", "text/plain");
    const id = await uploadTestObjectAndGetId(
      token,
      bucket.name,
      "hello.txt",
      file
    );
    const presign = await axios.post(
      `${FILES_URL}/buckets/${bucket.name}/objects/by-id/${id}/presign`,
      { operation: "read", expiresInSeconds: 60 },
      {
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      }
    );
    expect(presign.status).toBe(200);
    expect(new URL(presign.data.url).pathname).toMatch(
      /^\/v1\/files\/signed\//
    );

    const download = await axios.get(presign.data.url, {
      responseType: "text",
      validateStatus: () => true,
    });
    expect(download.status).toBe(200);
    expect(download.data).toBe("hello");
  });
});
