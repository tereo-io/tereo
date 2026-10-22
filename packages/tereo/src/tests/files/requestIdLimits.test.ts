import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  getTestAccessToken,
  waitFor,
} from "../support/files.js";

describe("client-supplied request metadata on files requests", () => {
  let token: string;
  let bucket: { name: string };

  beforeAll(async () => {
    token = await getTestAccessToken();
    bucket = await createTestBucket(token, { policy: "private" });
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("serves an audited mutation whose X-Request-ID would overflow the columns", async () => {
    const res = await axios.put(
      `${BASE_URL}/buckets/${bucket.name}`,
      { description: "long request id" },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Request-ID": "r".repeat(300),
        },
        validateStatus: () => true,
      }
    );
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("logs access with a User-Agent longer than its column", async () => {
    const requestId = randomUUID();
    const res = await axios.get(`${BASE_URL}/buckets/${bucket.name}/objects`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Request-ID": requestId,
        "User-Agent": `agent/${"x".repeat(700)}`,
      },
      validateStatus: () => true,
    });
    expect(res.status).toBe(HTTP_STATUS.OK);
    let row: Awaited<ReturnType<typeof prisma.accessLog.findFirst>> = null;
    await waitFor(async () => {
      row = await prisma.accessLog.findFirst({ where: { requestId } });
      return row !== null;
    }, 5_000);
    expect(row!.userAgent).toHaveLength(500);
  });
});
