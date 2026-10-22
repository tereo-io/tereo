import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomBytes } from "node:crypto";
import axios from "axios";
import {
  processShareSweepTick,
  SHARE_SWEEP_BATCH_LIMIT,
} from "../../jobs/shareSweep.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObject,
  uploadTestObjectAndGetId,
} from "./utils/test-helpers.js";

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

describe("Shares", () => {
  let token: string;
  let bucket: { id: number; name: string };
  let objectId: string;

  beforeAll(async () => {
    token = await getTestAccessToken();
    bucket = await createTestBucket(token, { policy: "private" });
    await uploadTestObject(
      token,
      bucket.name,
      "docs/readme.txt",
      createTestFile("readme content", "readme.txt", "text/plain")
    );
    await uploadTestObject(
      token,
      bucket.name,
      "docs/guide.txt",
      createTestFile("guide content", "guide.txt", "text/plain")
    );
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

  describe("POST /buckets/:name/shares (OBJECT)", () => {
    it("creates an object share and download 302-redirects to the signed URL", async () => {
      const createRes = await axios.post<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        { kind: "OBJECT", objectId },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      expect(createRes.status).toBe(HTTP_STATUS.CREATED);
      expect(createRes.data.kind).toBe("OBJECT");
      expect(createRes.data.hasPassword).toBe(false);
      expect(createRes.data.status).toBe("active");
      expect(createRes.data.url).toMatch(/\/shared\//);

      const dlRes = await axios.get(createRes.data.url, {
        maxRedirects: 0,
        validateStatus: () => true,
      });
      expect(dlRes.status).toBe(302);
      expect(dlRes.headers["location"]).toMatch(/\/signed\/objects\//);
    });

    it("rejects a share referencing an object in another bucket", async () => {
      const otherBucket = await createTestBucket(token, { policy: "private" });
      const res = await axios.post(
        `${BASE_URL}/buckets/${otherBucket.name}/shares`,
        { kind: "OBJECT", objectId },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(HTTP_STATUS.NOT_FOUND);
    });
  });

  describe("A share pinned to a version", () => {
    it("serves that version, not the current one", async () => {
      const versioned = await createTestBucket(token, { policy: "private" });
      await axios.put(
        `${BASE_URL}/buckets/${versioned.name}`,
        { versioningEnabled: true },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const first = await uploadTestObject(
        token,
        versioned.name,
        "pinned.txt",
        createTestFile("first", "pinned.txt", "text/plain")
      );
      const versions = await axios.get(
        `${BASE_URL}/buckets/${versioned.name}/objects/by-id/${first.id}/versions`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const versionId: string = versions.data.data[0].versionId;
      await uploadTestObject(
        token,
        versioned.name,
        "pinned.txt",
        createTestFile("second", "pinned.txt", "text/plain")
      );

      const share = await axios.post<ShareResponse>(
        `${BASE_URL}/buckets/${versioned.name}/shares`,
        { kind: "OBJECT", objectId: first.id, versionId },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      expect(share.status).toBe(HTTP_STATUS.CREATED);

      const redirect = await axios.get(share.data.url, {
        maxRedirects: 0,
        validateStatus: () => true,
      });
      expect(redirect.status).toBe(302);
      const signed = new URL(redirect.headers["location"]);
      expect(signed.searchParams.get("version")).toBe(versionId);

      const pinned = await axios.get(redirect.headers["location"], {
        validateStatus: () => true,
      });
      expect(pinned.status).toBe(HTTP_STATUS.OK);
      expect(pinned.data).toBe("first");

      // The version is bound by the signature.
      signed.searchParams.delete("version");
      const stripped = await axios.get(signed.toString(), {
        validateStatus: () => true,
      });
      expect(stripped.status).toBe(HTTP_STATUS.FORBIDDEN);
    });
  });

  describe("POST /buckets/:name/shares (ARCHIVE)", () => {
    it("creates a prefix archive share that 302-redirects to /signed/archives/", async () => {
      const createRes = await axios.post<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        { kind: "ARCHIVE", prefix: "docs/" },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      expect(createRes.status).toBe(HTTP_STATUS.CREATED);
      expect(createRes.data.kind).toBe("ARCHIVE");
      expect(createRes.data.archiveRequestId).toBeDefined();

      const dlRes = await axios.get(createRes.data.url, {
        maxRedirects: 0,
        validateStatus: () => true,
      });
      expect(dlRes.status).toBe(302);
      expect(dlRes.headers["location"]).toMatch(/\/signed\/archives\//);
    });

    it("creates a multi-key archive share", async () => {
      const res = await axios.post<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        {
          kind: "ARCHIVE",
          keys: ["docs/readme.txt", "report.pdf"],
          format: "zip",
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      expect(res.data.archiveRequest?.filename).toBeDefined();
    });

    it("rejects ARCHIVE with both prefix and keys", async () => {
      const res = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        {
          kind: "ARCHIVE",
          prefix: "docs/",
          keys: ["report.pdf"],
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
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

    it("blocks GET until unlocked with 401 requiresPassword", async () => {
      const share = await createPasswordShare("correct-horse-battery-staple");
      const getRes = await axios.get(share.url, {
        maxRedirects: 0,
        validateStatus: () => true,
      });
      expect(getRes.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(getRes.data.error).toBe("password_required");
      expect(getRes.data.requiresPassword).toBe(true);
    });

    it("returns the signed URL on correct password", async () => {
      const share = await createPasswordShare("open-sesame");
      const unlockRes = await axios.post(
        `${BASE_URL}/shared/${share.token}/unlock`,
        { password: "open-sesame" },
        { validateStatus: () => true }
      );
      expect(unlockRes.status).toBe(HTTP_STATUS.OK);
      expect(unlockRes.data.url).toMatch(/\/signed\/objects\//);
    });

    it("rejects incorrect password with 401", async () => {
      const share = await createPasswordShare("right");
      const unlockRes = await axios.post(
        `${BASE_URL}/shared/${share.token}/unlock`,
        { password: "wrong" },
        { validateStatus: () => true }
      );
      expect(unlockRes.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(unlockRes.data.error).toBe("invalid_password");
      // One wrong password is a typo, not worth an audit entry.
      expect(await unlockFailures(share.id)).toHaveLength(0);
    });

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

  describe("Revocation", () => {
    it("DELETE marks revoked and subsequent GET is 404 (uniform)", async () => {
      const createRes = await axios.post<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        { kind: "OBJECT", objectId },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      expect(createRes.status).toBe(HTTP_STATUS.CREATED);

      const revokeRes = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${createRes.data.id}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      expect(revokeRes.status).toBe(HTTP_STATUS.NO_CONTENT);

      const dlRes = await axios.get(createRes.data.url, {
        maxRedirects: 0,
        validateStatus: () => true,
      });
      expect(dlRes.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("idempotent double-revoke returns 204", async () => {
      const createRes = await axios.post<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        { kind: "OBJECT", objectId },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${createRes.data.id}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      const second = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${createRes.data.id}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      expect(second.status).toBe(HTTP_STATUS.NO_CONTENT);
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

  describe("Single-use URLs for capped shares", () => {
    const signedUrlFor = async (body: Record<string, unknown>) => {
      const created = await axios.post<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        body,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const redirect = await axios.get(created.data.url, {
        maxRedirects: 0,
        validateStatus: () => true,
      });
      expect(redirect.status).toBe(302);
      return redirect.headers["location"] as string;
    };
    const fetch = (url: string) =>
      axios.get(url, { validateStatus: () => true });

    it("serves a maxDownloads share's signed URL once", async () => {
      const url = await signedUrlFor({
        kind: "OBJECT",
        objectId,
        maxDownloads: 1,
      });
      const first = await fetch(url);
      expect(first.status).toBe(HTTP_STATUS.OK);
      expect(first.data).toBe("pdf-bytes");
      const second = await fetch(url);
      expect(second.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it("serves a capped archive share's signed URL once", async () => {
      const url = await signedUrlFor({
        kind: "ARCHIVE",
        prefix: "docs/",
        maxDownloads: 5,
      });
      expect((await fetch(url)).status).toBe(HTTP_STATUS.OK);
      expect((await fetch(url)).status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it("serves an unlocked capped share's URL once", async () => {
      const created = await axios.post<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        { kind: "OBJECT", objectId, maxDownloads: 1, password: "open-sesame" },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const unlocked = await axios.post(
        `${BASE_URL}/shared/${created.data.token}/unlock`,
        { password: "open-sesame" }
      );
      expect((await fetch(unlocked.data.url)).status).toBe(HTTP_STATUS.OK);
      expect((await fetch(unlocked.data.url)).status).toBe(
        HTTP_STATUS.FORBIDDEN
      );
    });

    it("leaves an uncapped share's signed URL replayable until it expires", async () => {
      const url = await signedUrlFor({ kind: "OBJECT", objectId });
      expect((await fetch(url)).status).toBe(HTTP_STATUS.OK);
      expect((await fetch(url)).status).toBe(HTTP_STATUS.OK);
    });
  });

  describe("HEAD status probe", () => {
    async function createShare(body: Record<string, unknown>) {
      const res = await axios.post<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        body,
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      return res.data;
    }

    async function downloadCount(id: string): Promise<number> {
      const res = await axios.get<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${id}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      return res.data.downloadCount;
    }

    it("reports an open share's details without counting a download", async () => {
      const share = await createShare({
        kind: "OBJECT",
        objectId,
        maxDownloads: 1,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });

      for (let i = 0; i < 3; i++) {
        const probe = await axios.head(share.url, {
          maxRedirects: 0,
          validateStatus: () => true,
        });
        expect(probe.status).toBe(HTTP_STATUS.OK);
        expect(probe.headers["x-share-kind"]).toBe("OBJECT");
        expect(probe.headers["content-type"]).toMatch(/^application\/pdf/);
        expect(probe.headers["x-share-size-bytes"]).toBe(
          String(Buffer.byteLength("pdf-bytes"))
        );
        expect(probe.headers["x-share-downloads-remaining"]).toBe("1");
        expect(probe.headers["x-share-expires-at"]).toBe(share.expiresAt);
        expect(probe.headers["content-disposition"]).toContain("report.pdf");
        expect(probe.headers["access-control-expose-headers"]).toContain(
          "X-Share-Downloads-Remaining"
        );
      }
      expect(await downloadCount(share.id)).toBe(0);

      // The one allowed download is still there, and counts.
      const dl = await axios.get(share.url, {
        maxRedirects: 0,
        validateStatus: () => true,
      });
      expect(dl.status).toBe(302);
      expect(await downloadCount(share.id)).toBe(1);

      const after = await axios.head(share.url, {
        maxRedirects: 0,
        validateStatus: () => true,
      });
      expect(after.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("answers the cosmetic filename form the same way", async () => {
      const share = await createShare({
        kind: "OBJECT",
        objectId,
        urlFilename: "custom-name.pdf",
      });
      const probe = await axios.head(share.url, {
        maxRedirects: 0,
        validateStatus: () => true,
      });
      expect(probe.status).toBe(HTTP_STATUS.OK);
      expect(probe.headers["content-disposition"]).toContain("custom-name.pdf");
      expect(probe.headers["x-share-downloads-remaining"]).toBeUndefined();
      expect(probe.headers["x-share-expires-at"]).toBe(share.expiresAt);
      expect(await downloadCount(share.id)).toBe(0);
    });

    it("returns a bare 401 for a password share, with no file details", async () => {
      const share = await createShare({
        kind: "OBJECT",
        objectId,
        password: "probe-secret",
        maxDownloads: 5,
      });
      const probe = await axios.head(share.url, {
        maxRedirects: 0,
        headers: { Accept: "text/html" },
        validateStatus: () => true,
      });
      expect(probe.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(probe.headers["x-share-kind"]).toBeUndefined();
      expect(probe.headers["x-share-size-bytes"]).toBeUndefined();
      expect(probe.headers["x-share-downloads-remaining"]).toBeUndefined();
      expect(probe.headers["content-disposition"]).toBeUndefined();
      expect(await downloadCount(share.id)).toBe(0);
    });

    it("reports an archive share as ARCHIVE without a size", async () => {
      const share = await createShare({ kind: "ARCHIVE", prefix: "docs/" });
      const probe = await axios.head(share.url, {
        maxRedirects: 0,
        validateStatus: () => true,
      });
      expect(probe.status).toBe(HTTP_STATUS.OK);
      expect(probe.headers["x-share-kind"]).toBe("ARCHIVE");
      expect(probe.headers["content-type"]).toMatch(/^application\/zip/);
      expect(probe.headers["x-share-size-bytes"]).toBeUndefined();
      expect(await downloadCount(share.id)).toBe(0);
    });

    it("returns the uniform 404 for revoked and unknown shares", async () => {
      const share = await createShare({ kind: "OBJECT", objectId });
      await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${share.id}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const revoked = await axios.head(share.url, {
        validateStatus: () => true,
      });
      expect(revoked.status).toBe(HTTP_STATUS.NOT_FOUND);

      const unknown = await axios.head(`${BASE_URL}/shared/no-such-token`, {
        validateStatus: () => true,
      });
      expect(unknown.status).toBe(HTTP_STATUS.NOT_FOUND);
    });
  });

  describe("urlFilename", () => {
    it("renders urlFilename as a cosmetic suffix, ignored by the route", async () => {
      const res = await axios.post<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        { kind: "OBJECT", objectId, urlFilename: "custom-name.pdf" },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      expect(res.data.url).toContain("/custom-name.pdf");
      // The route ignores the trailing segment — a different suffix still
      // resolves the same share.
      const mangled = res.data.url.replace("custom-name.pdf", "anything.bin");
      const dl = await axios.get(mangled, {
        maxRedirects: 0,
        validateStatus: () => true,
      });
      expect(dl.status).toBe(302);
    });
  });

  describe("Expiry", () => {
    const MAX_MS = 365 * 24 * 60 * 60 * 1000;
    const expectAboutMaxFromNow = (expiresAt: string | null) => {
      expect(expiresAt).not.toBeNull();
      const delta = new Date(expiresAt!).getTime() - (Date.now() + MAX_MS);
      expect(Math.abs(delta)).toBeLessThan(60_000);
    };
    const create = async () => {
      const res = await axios.post<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        { kind: "OBJECT", objectId },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      return res.data;
    };

    it("gives a share created without one the longest expiry allowed", async () => {
      const share = await create();
      expectAboutMaxFromNow(share.expiresAt);
    });

    it("sets the longest expiry allowed on PATCH expiresAt: null", async () => {
      const share = await create();
      const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await axios.patch(
        `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${share.id}`,
        { expiresAt: soon },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const patch = await axios.patch<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${share.id}`,
        { expiresAt: null },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      expect(patch.status).toBe(HTTP_STATUS.OK);
      expectAboutMaxFromNow(patch.data.expiresAt);
    });

    it("fills in an expiry for a share that has none, from its creation", async () => {
      const share = await create();
      // Past the cap, but not yet past the retention grace.
      const createdAt = new Date(Date.now() - 370 * 24 * 60 * 60 * 1000);
      await prisma.share.update({
        where: { id: share.id },
        data: { expiresAt: null, createdAt },
      });

      await processShareSweepTick();

      const row = await prisma.share.findUniqueOrThrow({
        where: { id: share.id },
      });
      expect(row.expiresAt?.getTime()).toBe(createdAt.getTime() + MAX_MS);
      const backfills = await prisma.auditLogEntry.findMany({
        where: {
          entityType: "shareExpiryBackfill",
          entityId: String(bucket.id),
        },
      });
      const entry = backfills.find((e) =>
        JSON.stringify(e.metadata).includes(share.id)
      );
      expect(entry).toMatchObject({ action: "UPDATE", userId: SYSTEM_USER_ID });
      const res = await axios.get(share.url, {
        maxRedirects: 0,
        validateStatus: () => true,
      });
      expect(res.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("fills at most a batch per tick, and asks for another when it filled one", async () => {
      const share = await create();
      const createdAt = new Date(Date.now() - 370 * 24 * 60 * 60 * 1000);
      const row = await prisma.share.update({
        where: { id: share.id },
        data: { expiresAt: null, createdAt },
      });
      const { id: _id, token: _token, updatedAt: _updatedAt, ...copy } = row;
      await prisma.share.createMany({
        data: Array.from({ length: SHARE_SWEEP_BATCH_LIMIT }, () => ({
          ...copy,
          token: randomBytes(24).toString("base64url"),
        })),
      });
      const ours = { bucketId: bucket.id, createdAt, expiresAt: null };
      const since = new Date();

      const first = await processShareSweepTick();
      expect(first.hasMore).toBe(true);
      const left = await prisma.share.count({ where: ours });
      expect(left).toBeGreaterThanOrEqual(1);

      for (
        let i = 0;
        i < 5 && (await prisma.share.count({ where: ours }));
        i++
      ) {
        await processShareSweepTick();
      }
      expect(await prisma.share.count({ where: ours })).toBe(0);

      const entries = await prisma.auditLogEntry.findMany({
        where: {
          entityType: "shareExpiryBackfill",
          entityId: String(bucket.id),
          createdAt: { gte: since },
        },
      });
      expect(entries.length).toBeGreaterThanOrEqual(2);
      for (const entry of entries) {
        const { shares } = entry.metadata as { shares: unknown[] };
        expect(shares.length).toBeLessThanOrEqual(SHARE_SWEEP_BATCH_LIMIT);
      }
    });
  });

  describe("List + Get + Update", () => {
    it("GET /shares lists shares for a bucket", async () => {
      const list = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      expect(list.status).toBe(HTTP_STATUS.OK);
      const ids = list.data.data.map((sh: ShareResponse) => sh.id);
      expect(ids.length).toBeGreaterThan(0);

      const first = list.data.data[0] as ShareResponse;
      const get = await axios.get<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${first.id}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      expect(get.status).toBe(HTTP_STATUS.OK);
      expect(get.data.id).toBe(first.id);
    });

    it("rejects a createdByUserId filter that is not a UUID", async () => {
      const res = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/shares?filter[createdByUserId]=abc`,
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("PATCH updates note + maxDownloads", async () => {
      const create = await axios.post<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        { kind: "OBJECT", objectId, note: "initial" },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      const patch = await axios.patch<ShareResponse>(
        `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${create.data.id}`,
        { note: "updated", maxDownloads: 5 },
        {
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true,
        }
      );
      expect(patch.status).toBe(HTTP_STATUS.OK);
      expect(patch.data.maxDownloads).toBe(5);
      expect((patch.data as unknown as { note: string }).note).toBe("updated");
    });

    it("pages by expiresAt past shares from before expiries were required", async () => {
      const own = await createTestBucket(token, { policy: "private" });
      const id = await uploadTestObjectAndGetId(
        token,
        own.name,
        "p.txt",
        createTestFile("paging", "p.txt", "text/plain")
      );
      const created: string[] = [];
      const day = 24 * 60 * 60 * 1000;
      for (const expiresAt of [
        null,
        new Date(Date.now() + day).toISOString(),
        null,
        new Date(Date.now() + 2 * day).toISOString(),
      ]) {
        const res = await axios.post<ShareResponse>(
          `${BASE_URL}/buckets/${own.name}/shares`,
          { kind: "OBJECT", objectId: id, ...(expiresAt ? { expiresAt } : {}) },
          { headers: { Authorization: `Bearer ${token}` } }
        );
        created.push(res.data.id);
        // Rows created before every share had an expiry still have none.
        if (!expiresAt) {
          await prisma.share.update({
            where: { id: res.data.id },
            data: { expiresAt: null },
          });
        }
      }

      for (const sortDir of ["asc", "desc"]) {
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 10; page++) {
          const res: {
            data: { data: ShareResponse[]; nextCursor: string | null };
          } = await axios.get(`${BASE_URL}/buckets/${own.name}/shares`, {
            headers: { Authorization: `Bearer ${token}` },
            params: {
              sort: "expiresAt",
              sortDir,
              limit: 1,
              ...(cursor ? { cursor } : {}),
            },
          });
          seen.push(...res.data.data.map((s) => s.id));
          cursor = res.data.nextCursor;
          if (!cursor) break;
        }
        expect([sortDir, seen.sort()]).toEqual([sortDir, [...created].sort()]);
      }
    });
  });
});
