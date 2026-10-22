// @module-tag int
// @module-tag files
import { SYSTEM_USER_ID } from "../../../../../../definitions/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObjectAndGetId,
} from "../../../../../support/files.js";

describe("GET /v1/files/shared/:token, POST /v1/files/shared/:token/unlock", () => {
  interface ShareResponse {
    id: string;
    token: string;
    bucketId: number;
    kind: "OBJECT" | "ARCHIVE";
    url: string;
    urlFilename: string | null;
    objectId: string | null;
    versionId: string | null;
    archiveRequestId: string | null;
    hasPassword: boolean;
    expiresAt: string | null;
    maxDownloads: number | null;
    downloadCount: number;
    revokedAt: string | null;
    status: "active" | "revoked" | "expired" | "exhausted";
    object: { id: string; objectKey: string } | null;
    archiveRequest: { filename: string } | null;
  }

  const unlockFailures = (shareId: string) =>
    prisma.auditLogEntry.findMany({
      where: { entityType: "shareUnlockFailure", entityId: shareId },
    });
  let token: string;
  let bucket: { id: number; name: string };
  let objectId: string;

  beforeAll(async () => {
    token = await getTestAccessToken();
    bucket = await createTestBucket(token, { policy: "private" });
    objectId = await uploadTestObjectAndGetId(
      token,
      bucket.name,
      "report.pdf",
      createTestFile("pdf-bytes", "report.pdf", "application/pdf")
    );
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("Password protection", () => {
    async function createPasswordShare(password: string) {
      const res = await axios.post<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        { kind: "OBJECT", objectId, password },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      return res.data;
    }

    it("refuses unlock attempts past the limit with the shared 429", async () => {
      const share = await createPasswordShare("right");
      const unlock = () =>
        axios.post(
          `${BASE_URL}/shared/${share.token}/unlock`,
          { password: "wrong" },
          { validateStatus: () => true }
        );
      // FILE_SERVICE_SHARE_UNLOCK_MAX_ATTEMPTS defaults to 5.
      for (let i = 0; i < 5; i++) {
        expect((await unlock()).status).toBe(HTTP_STATUS.UNAUTHORIZED);
      }
      const limited = await unlock();
      expect(limited.status).toBe(429);
      expect(limited.data.error).toBe("too_many_requests");
      expect(limited.data.retry_after).toBeGreaterThan(0);
      expect(limited.headers["retry-after"]).toBe(
        String(limited.data.retry_after)
      );

      // Audited once, by the wrong password that used up the window.
      const failures = await unlockFailures(share.id);
      expect(failures).toHaveLength(1);
      expect(failures[0].userId).toBe(SYSTEM_USER_ID);
      expect(failures[0].metadata).toMatchObject({
        reason: "unlock_attempts_exhausted",
        attemptsInWindow: 5,
      });
      expect(JSON.stringify(failures[0].metadata)).not.toContain("wrong");
    });
  });

  describe("Per-share unlock backoff", () => {
    it("slows wrong passwords spread over many addresses, until a correct one", async () => {
      const create = await axios.post<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        { kind: "OBJECT", objectId, password: "right" },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const share = create.data;
      // A fresh address each time, so the per-(token, IP) window never fills.
      const unlockFrom = (n: number, password: string) =>
        axios.post(
          `${BASE_URL}/shared/${share.token}/unlock`,
          { password },
          {
            headers: { "X-Forwarded-For": `198.51.100.${n}` },
            validateStatus: () => true,
          }
        );

      for (let i = 0; i < 10; i++) {
        expect((await unlockFrom(i, "wrong")).status).toBe(
          HTTP_STATUS.UNAUTHORIZED
        );
      }
      const limited = await unlockFrom(100, "wrong");
      expect(limited.status).toBe(429);
      expect(limited.data.error).toBe("too_many_requests");
      // An address that has already tried waits out the delay, even with
      // the right password.
      expect((await unlockFrom(100, "right")).status).toBe(429);
      // Only the wrong password verified during the delay is audited.
      const failures = await unlockFailures(share.id);
      expect(failures.map((f) => f.metadata)).toEqual([
        expect.objectContaining({
          reason: "invalid_password_during_backoff",
          ipAddress: "198.51.100.100",
        }),
      ]);

      // The delay after ten failures is one second.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect((await unlockFrom(101, "right")).status).toBe(HTTP_STATUS.OK);
      expect((await unlockFrom(102, "wrong")).status).toBe(
        HTTP_STATUS.UNAUTHORIZED
      );
    });

    it("still lets a recipient's correct password through during the delay", async () => {
      const create = await axios.post<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        { kind: "OBJECT", objectId, password: "right" },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const share = create.data;
      const unlockFrom = (n: number, password: string) =>
        axios.post(
          `${BASE_URL}/shared/${share.token}/unlock`,
          { password },
          {
            headers: { "X-Forwarded-For": `198.51.101.${n}` },
            validateStatus: () => true,
          }
        );

      // Anyone with the link can start the delay...
      for (let i = 0; i < 12; i++) {
        await unlockFrom(i, "wrong");
      }
      expect((await unlockFrom(50, "wrong")).status).toBe(429);
      // ...but it does not lock the recipient out.
      expect((await unlockFrom(51, "right")).status).toBe(HTTP_STATUS.OK);
      // A correct password resets the delay.
      expect((await unlockFrom(52, "wrong")).status).toBe(
        HTTP_STATUS.UNAUTHORIZED
      );
    });
  });

  describe("Download caps", () => {
    it("maxDownloads=2: third GET returns 404 (uniform-not-serveable)", async () => {
      const createRes = await axios.post<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        { kind: "OBJECT", objectId, maxDownloads: 2 },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      const url = createRes.data.url;
      const r1 = await axios.get(url, {
        maxRedirects: 0,
        validateStatus: () => true,
      });
      const r2 = await axios.get(url, {
        maxRedirects: 0,
        validateStatus: () => true,
      });
      const r3 = await axios.get(url, {
        maxRedirects: 0,
        validateStatus: () => true,
      });
      expect(r1.status).toBe(302);
      expect(r2.status).toBe(302);
      expect(r3.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("concurrent downloads respect maxDownloads atomically", async () => {
      const createRes = await axios.post<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        { kind: "OBJECT", objectId, maxDownloads: 3 },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      const url = createRes.data.url;
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          axios.get(url, {
            maxRedirects: 0,
            validateStatus: () => true,
          })
        )
      );
      const successes = results.filter((r) => r.status === 302).length;
      const rejections = results.filter(
        (r) => r.status === HTTP_STATUS.NOT_FOUND
      ).length;
      expect(successes).toBe(3);
      expect(rejections).toBe(17);
    });
  });
});
