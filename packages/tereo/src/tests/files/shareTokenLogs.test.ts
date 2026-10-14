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
  uploadTestObjectAndGetId,
  waitFor,
} from "./utils/test-helpers.js";

describe("share tokens in the access log", () => {
  let token: string;
  let bucket: { name: string };
  let objectId: string;

  beforeAll(async () => {
    token = await getTestAccessToken();
    bucket = await createTestBucket(token, { policy: "private" });
    objectId = await uploadTestObjectAndGetId(
      token,
      bucket.name,
      "secret.txt",
      createTestFile("secret", "secret.txt", "text/plain")
    );
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("records a password share's 401 without the token", async () => {
    const share = await axios.post<{ url: string; token: string }>(
      `${BASE_URL}/buckets/${bucket.name}/shares`,
      { kind: "OBJECT", objectId, password: "log-secret" },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const requestId = randomUUID();
    const res = await axios.get(share.data.url, {
      maxRedirects: 0,
      headers: { Accept: "application/json", "X-Request-ID": requestId },
      validateStatus: () => true,
    });
    expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(res.data.error).toBe("password_required");

    let row: Awaited<ReturnType<typeof prisma.accessLog.findFirst>> = null;
    await waitFor(async () => {
      row = await prisma.accessLog.findFirst({ where: { requestId } });
      return row !== null;
    }, 5_000);
    expect(row!.operation).toMatch(/^GET \/shared\/:token(\/|$)/);
    expect(`${row!.operation} ${row!.errorMessage}`).not.toContain(
      share.data.token
    );
  });
});
