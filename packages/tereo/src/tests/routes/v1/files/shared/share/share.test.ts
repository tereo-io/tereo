// @module-tag int
// @module-tag files
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
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
  uploadTestObjectAndGetId,
  waitFor,
  bucketOwnerAccess,
} from "../../../../../support/files.js";

describe("GET and HEAD /v1/files/shared/:token, POST /v1/files/shared/:token/unlock", () => {
  describe("Shares", () => {
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
  });

  describe("signed URLs", () => {
    const anyStatus = { validateStatus: () => true, maxRedirects: 0 };

    // The access log is written after the response is sent.
    const waitForAccessLog = async (where: Record<string, unknown>) => {
      let row: Awaited<ReturnType<typeof prisma.accessLog.findFirst>> = null;
      await waitFor(async () => {
        row = await prisma.accessLog.findFirst({
          where,
          orderBy: { timestamp: "desc" },
        });
        return row !== null;
      }, 5000);
      return row!;
    };
    let admin: string;
    let bucket: { id: number; name: string };
    let objectId: string;
    const auth = (token: string) => ({
      headers: { Authorization: `Bearer ${token}` },
      ...anyStatus,
    });

    beforeAll(async () => {
      admin = await getTestAccessToken();
      bucket = await createTestBucket(admin, { policy: "private" });
      objectId = await uploadTestObjectAndGetId(
        admin,
        bucket.name,
        "docs/report.pdf",
        createTestFile("pdf-bytes", "report.pdf", "application/pdf")
      );
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    const createShare = async (
      body: Record<string, unknown>,
      token: string = admin
    ) => {
      const res = await axios.post<{ id: string; token: string; url: string }>(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        body,
        auth(token)
      );
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      return res.data;
    };

    const presign = async (
      token: string,
      operation: "read" | "write",
      id: string = objectId
    ) => {
      const res = await axios.post<{ url: string }>(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${id}/presign`,
        { operation, expiresInSeconds: 300 },
        auth(token)
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      return res.data.url;
    };

    describe("filename", () => {
      it("carries a share's cosmetic filename to the unlock page, up to 255 characters", async () => {
        const share = await createShare({
          kind: "OBJECT",
          objectId,
          password: "open-sesame",
        });
        const browser = { ...anyStatus, headers: { Accept: "text/html" } };
        const shared = `${BASE_URL}/shared/${share.token}`;
        const ok = await axios.get(`${shared}/custom.pdf`, browser);
        expect(ok.status).toBe(302);
        expect(ok.headers["location"]).toMatch(/\/custom\.pdf$/);

        const long = await axios.get(`${shared}/${"a".repeat(256)}`, browser);
        expect(long.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });

      it("refuses a filename longer than 255 characters", async () => {
        const url = new URL(await presign(admin, "read"));
        url.searchParams.set("filename", `${"a".repeat(256)}.pdf`);
        expect((await axios.get(url.toString(), anyStatus)).status).toBe(
          HTTP_STATUS.BAD_REQUEST
        );
      });
    });

    describe("ranges", () => {
      it("serves ranges through a share", async () => {
        const content = Buffer.from(
          `${randomUUID()}${randomUUID()}${randomUUID()}`.slice(0, 100)
        );
        const id = await uploadTestObjectAndGetId(
          admin,
          bucket.name,
          `ranges/${randomUUID()}.bin`,
          {
            buffer: content,
            filename: "f.bin",
            contentType: "application/octet-stream",
          }
        );
        const share = await createShare({ kind: "OBJECT", objectId: id });
        const shared = await axios.get<ArrayBuffer>(share.url, {
          headers: { Range: "bytes=-3" },
          responseType: "arraybuffer",
          validateStatus: () => true,
        });
        expect(shared.status).toBe(206);
        expect(Buffer.from(shared.data)).toEqual(content.subarray(97));
      });
    });

    describe("access logs", () => {
      it("records the object of a share download and an unlock", async () => {
        const open = await createShare({ kind: "OBJECT", objectId });
        const download = await axios.get(open.url, anyStatus);
        expect(download.status).toBe(302);
        expect(
          await waitForAccessLog({
            requestId: download.headers["x-request-id"],
          })
        ).toMatchObject({ objectId, operation: "DOWNLOAD_SHARE" });

        const locked = await createShare({
          kind: "OBJECT",
          objectId,
          password: "open-sesame",
        });
        const unlock = await axios.post(
          `${BASE_URL}/shared/${locked.token}/unlock`,
          { password: "open-sesame" },
          anyStatus
        );
        expect(unlock.status).toBe(HTTP_STATUS.OK);
        expect(
          await waitForAccessLog({ requestId: unlock.headers["x-request-id"] })
        ).toMatchObject({ objectId, operation: "UNLOCK_SHARE" });
      });
    });

    describe("unlock", () => {
      it("answers a share without a password with no password sent", async () => {
        const share = await createShare({ kind: "OBJECT", objectId });
        const res = await axios.post(
          `${BASE_URL}/shared/${share.token}/unlock`,
          {},
          anyStatus
        );
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect((await axios.get(res.data.url, anyStatus)).status).toBe(
          HTTP_STATUS.OK
        );
      });

      it("still requires the password of a password share", async () => {
        const share = await createShare({
          kind: "OBJECT",
          objectId,
          password: "open-sesame",
        });
        const res = await axios.post(
          `${BASE_URL}/shared/${share.token}/unlock`,
          {},
          anyStatus
        );
        expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
      });

      it("answers HEAD on a password share with a bodiless 401", async () => {
        const share = await createShare({
          kind: "OBJECT",
          objectId,
          password: "open-sesame",
        });
        const res = await axios.head(share.url, anyStatus);
        expect(res.status).toBe(HTTP_STATUS.UNAUTHORIZED);
        expect(res.data).toBe("");
      });
    });
  });

  describe("files integrity", () => {
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

    const upload = (bucketName: string, key: string, body: string) =>
      uploadTestObject(
        token,
        bucketName,
        key,
        createTestFile(body, key.split("/").pop(), "text/plain")
      );

    describe("shares", () => {
      it("an expired archive's share is a 404 that counts no download", async () => {
        const bucket = await createTestBucket(token);
        await upload(bucket.name, "gone/1.txt", `1 ${randomUUID()}`);
        const created = await axios.post(
          `${BASE_URL}/buckets/${bucket.name}/shares`,
          { kind: "ARCHIVE", prefix: "gone/" },
          auth()
        );
        await prisma.archiveRequest.update({
          where: { id: created.data.archiveRequestId },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });

        const res = await axios.get(created.data.url, {
          maxRedirects: 0,
          validateStatus: () => true,
        });
        expect(res.status).toBe(HTTP_STATUS.NOT_FOUND);
        const share = await prisma.share.findUniqueOrThrow({
          where: { id: created.data.id },
        });
        expect(share.downloadCount).toBe(0);
      });
    });
  });

  describe("Bucket ownership and active grants", () => {
    // Everything a bucket owner does, but no `file-service.admin`.
    const { as, member, grant } = bucketOwnerAccess;

    afterAll(async () => {
      await cleanupTestEntities();
    });

    it("reports a deactivated creator's share as not serving", async () => {
      const owner = await member();
      const creator = await member();
      const bucket = await createTestBucket(owner.token);
      const object = await uploadTestObject(
        owner.token,
        bucket.name,
        "doc.txt",
        createTestFile("doc")
      );
      await grant(owner.token, bucket.name, creator.userId, { canRead: true });
      const share = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        { kind: "OBJECT", objectId: object.id },
        as(creator.token)
      );
      expect(share.data.status).toBe("active");
      await prisma.user.update({
        where: { id: creator.userId },
        data: { isActive: false },
      });

      const res = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${share.data.id}`,
        as(owner.token)
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.data.status).toBe("creator_inactive");
      expect(res.data.creator).toEqual({
        id: creator.userId,
        email: expect.any(String),
        name: expect.any(String),
      });
    });
  });
});
