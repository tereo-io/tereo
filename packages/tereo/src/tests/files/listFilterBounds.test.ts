import { afterAll, beforeAll, describe, expect, it } from "vitest";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  getTestAccessToken,
} from "./utils/test-helpers.js";

describe("object list filters", () => {
  let token: string;
  let bucketName: string;

  const list = (params: Record<string, string>) =>
    axios.get(`${BASE_URL}/buckets/${bucketName}/objects`, {
      params,
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

  it("refuses an objectKey filter longer than a key", async () => {
    expect((await list({ "filter[objectKey]": "k".repeat(1024) })).status).toBe(
      HTTP_STATUS.OK
    );
    expect((await list({ "filter[objectKey]": "k".repeat(1025) })).status).toBe(
      HTTP_STATUS.BAD_REQUEST
    );
  });

  it("refuses a contentType filter longer than a content type", async () => {
    const res = await list({
      "filter[contentType]": "t".repeat(256),
      "filter[contentType_op]": "contains",
    });
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });
});
