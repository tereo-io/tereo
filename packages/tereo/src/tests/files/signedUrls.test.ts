import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrincipalToken } from "../support/principals.js";
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
  grantTestPermission,
  uploadTestObjectAndGetId,
  waitFor,
} from "../support/files.js";

const anyStatus = { validateStatus: () => true, maxRedirects: 0 };

const MEMBER_PERMISSIONS = [
  "file-service.objects.read",
  "file-service.objects.write",
  "file-service.shares.read",
  "file-service.shares.write",
];

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

describe("signed URLs", () => {
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

  const signedUrlFor = async (shareUrl: string) => {
    const redirect = await axios.get(shareUrl, anyStatus);
    expect(redirect.status).toBe(302);
    return redirect.headers["location"] as string;
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

  const createArchive = async (token: string) => {
    const res = await axios.post<{ id: string; url: string }>(
      `${BASE_URL}/buckets/${bucket.name}/archives`,
      { prefix: "docs/" },
      auth(token)
    );
    expect(res.status).toBe(HTTP_STATUS.CREATED);
    return res.data;
  };

  const put = (url: string, body: string) =>
    axios.put(url, body, {
      headers: { "Content-Type": "text/plain" },
      ...anyStatus,
    });

  describe("HEAD", () => {
    it("probes a capped share's URL without spending it", async () => {
      const share = await createShare({
        kind: "OBJECT",
        objectId,
        maxDownloads: 1,
      });
      const url = await signedUrlFor(share.url);

      for (let i = 0; i < 2; i++) {
        const head = await axios.head(url, anyStatus);
        expect(head.status).toBe(HTTP_STATUS.OK);
        expect(head.headers["content-type"]).toMatch(/^application\/pdf/);
        expect(head.headers["content-length"]).toBe(
          String(Buffer.byteLength("pdf-bytes"))
        );
        expect(head.headers["accept-ranges"]).toBe("bytes");
        expect(head.headers["etag"]).toBeTruthy();
        expect(head.headers["last-modified"]).toBeTruthy();
        expect(head.headers["content-disposition"]).toMatch(/^attachment/);
        expect(head.headers["x-content-type-options"]).toBe("nosniff");
        expect(head.headers["content-security-policy"]).toBeTruthy();
      }

      const get = await axios.get(url, anyStatus);
      expect(get.status).toBe(HTTP_STATUS.OK);
      expect(get.data).toBe("pdf-bytes");
      expect((await axios.get(url, anyStatus)).status).toBe(
        HTTP_STATUS.FORBIDDEN
      );
    });

    it("probes a capped archive share's URL without spending it", async () => {
      const share = await createShare({
        kind: "ARCHIVE",
        prefix: "docs/",
        maxDownloads: 1,
      });
      const url = await signedUrlFor(share.url);

      const head = await axios.head(url, anyStatus);
      expect(head.status).toBe(HTTP_STATUS.OK);
      expect(head.headers["content-type"]).toBe("application/zip");
      expect(head.headers["content-disposition"]).toMatch(/^attachment/);

      expect((await axios.get(url, anyStatus)).status).toBe(HTTP_STATUS.OK);
      expect((await axios.get(url, anyStatus)).status).toBe(
        HTTP_STATUS.FORBIDDEN
      );
    });
  });

  describe("a capped share's nonce", () => {
    it("survives a 404 after the signature verifies", async () => {
      const share = await createShare({
        kind: "OBJECT",
        objectId,
        maxDownloads: 1,
      });
      const url = await signedUrlFor(share.url);

      await prisma.object.update({
        where: { id: objectId },
        data: { deletedAt: new Date() },
      });
      try {
        expect((await axios.get(url, anyStatus)).status).toBe(
          HTTP_STATUS.NOT_FOUND
        );
      } finally {
        await prisma.object.update({
          where: { id: objectId },
          data: { deletedAt: null },
        });
      }
      expect((await axios.get(url, anyStatus)).status).toBe(HTTP_STATUS.OK);
    });

    it("survives a 304 and answers a failed If-Match with 412", async () => {
      const share = await createShare({
        kind: "OBJECT",
        objectId,
        maxDownloads: 1,
      });
      const url = await signedUrlFor(share.url);
      const etag = (await axios.head(url, anyStatus)).headers["etag"];

      const notModified = await axios.get(url, {
        headers: { "If-None-Match": etag },
        ...anyStatus,
      });
      expect(notModified.status).toBe(304);
      expect(notModified.headers["etag"]).toBe(etag);
      const failed = await axios.get(url, {
        headers: { "If-Match": '"not-the-etag"' },
        ...anyStatus,
      });
      expect(failed.status).toBe(412);

      const get = await axios.get(url, anyStatus);
      expect(get.status).toBe(HTTP_STATUS.OK);
      expect(get.data).toBe("pdf-bytes");
    });

    it("survives an unsatisfiable range", async () => {
      const share = await createShare({
        kind: "OBJECT",
        objectId,
        maxDownloads: 1,
      });
      const url = await signedUrlFor(share.url);

      const ranged = await axios.get(url, {
        ...anyStatus,
        headers: { Range: "bytes=1000-2000" },
      });
      expect(ranged.status).toBe(416);
      expect((await axios.get(url, anyStatus)).status).toBe(HTTP_STATUS.OK);
    });

    it("lets only one of two concurrent GETs through", async () => {
      const share = await createShare({
        kind: "OBJECT",
        objectId,
        maxDownloads: 1,
      });
      const url = await signedUrlFor(share.url);
      const statuses = (
        await Promise.all([
          axios.get(url, anyStatus),
          axios.get(url, anyStatus),
        ])
      ).map((r) => r.status);
      expect(statuses.sort()).toEqual([HTTP_STATUS.OK, HTTP_STATUS.FORBIDDEN]);
    });
  });

  describe("archive ids", () => {
    const probe = (id: string) =>
      axios.get(
        `${BASE_URL}/signed/archives/${id}?op=archive&expires=${
          Math.floor(Date.now() / 1000) + 60
        }&nonce=abc&v=1&sig=bogus`,
        anyStatus
      );

    it("answers a missing and an existing archive alike before the signature verifies", async () => {
      const archive = await createArchive(admin);
      const existing = await probe(archive.id);
      const missing = await probe(randomUUID());
      expect(existing.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(missing.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(missing.data).toEqual(existing.data);
    });
  });

  describe("filename", () => {
    it("binds a share's filename into the signature", async () => {
      const share = await createShare({
        kind: "OBJECT",
        objectId,
        urlFilename: "quarterly.pdf",
      });
      const url = new URL(await signedUrlFor(share.url));
      expect(url.searchParams.get("filename")).toBe("quarterly.pdf");

      const ok = await axios.get(url.toString(), anyStatus);
      expect(ok.status).toBe(HTTP_STATUS.OK);
      expect(ok.headers["content-disposition"]).toContain("quarterly.pdf");

      url.searchParams.set("filename", "evil.html");
      expect((await axios.get(url.toString(), anyStatus)).status).toBe(
        HTTP_STATUS.FORBIDDEN
      );
      url.searchParams.delete("filename");
      expect((await axios.get(url.toString(), anyStatus)).status).toBe(
        HTTP_STATUS.FORBIDDEN
      );
    });

    it("answers a malformed object id or bucket name like a wrong signature", async () => {
      const signed = new URL(await presign(admin, "read"));
      const tampered = new URL(signed);
      tampered.searchParams.set("sig", "bogus");
      const wrong = await axios.get(tampered.toString(), anyStatus);
      expect(wrong.status).toBe(HTTP_STATUS.FORBIDDEN);

      for (const [from, to] of [
        [`/by-id/${objectId}`, "/by-id/not-a-uuid"],
        [`/objects/${bucket.name}/`, "/objects/Not_A_Bucket/"],
      ]) {
        const url = new URL(signed);
        url.pathname = url.pathname.replace(from, to);
        const res = await axios.get(url.toString(), anyStatus);
        expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
        expect(res.data).toEqual(wrong.data);
      }
    });

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

  describe("the signer's access", () => {
    const member = async () => {
      const userId = randomUUID();
      const token = await getTestPrincipalToken({
        userId,
        permissions: MEMBER_PERMISSIONS,
      });
      await grantTestPermission(admin, bucket.name, userId, {
        canRead: true,
        canWrite: true,
      });
      return { userId, token };
    };

    const revokeGrant = (userId: string) =>
      prisma.bucketPermission.updateMany({
        where: { bucketId: bucket.id, userId },
        data: { revokedAt: new Date() },
      });

    const deactivate = (userId: string) =>
      prisma.user.update({ where: { id: userId }, data: { isActive: false } });

    it.each([
      ["revoked grant", revokeGrant],
      ["deactivated signer", deactivate],
    ])("refuses read, write and archive URLs after a %s", async (_, lose) => {
      const id = await uploadTestObjectAndGetId(
        admin,
        bucket.name,
        `signer/${randomUUID()}.txt`,
        createTestFile("before")
      );
      const { userId, token } = await member();
      const readUrl = await presign(token, "read", id);
      const writeUrl = await presign(token, "write", id);
      const archive = await createArchive(token);

      expect((await axios.get(readUrl, anyStatus)).status).toBe(HTTP_STATUS.OK);
      expect((await axios.get(archive.url, anyStatus)).status).toBe(
        HTTP_STATUS.OK
      );

      await lose(userId);

      expect((await axios.get(readUrl, anyStatus)).status).toBe(
        HTTP_STATUS.FORBIDDEN
      );
      expect((await axios.head(readUrl, anyStatus)).status).toBe(
        HTTP_STATUS.FORBIDDEN
      );
      expect((await put(writeUrl, "after")).status).toBe(HTTP_STATUS.FORBIDDEN);
      expect((await axios.get(archive.url, anyStatus)).status).toBe(
        HTTP_STATUS.FORBIDDEN
      );
    });

    it("stops serving a share once its creator is deactivated", async () => {
      const { userId, token } = await member();
      const share = await createShare({ kind: "OBJECT", objectId }, token);
      const url = await signedUrlFor(share.url);
      expect((await axios.get(url, anyStatus)).status).toBe(HTTP_STATUS.OK);

      await deactivate(userId);

      expect((await axios.get(url, anyStatus)).status).toBe(
        HTTP_STATUS.FORBIDDEN
      );
      expect((await axios.get(share.url, anyStatus)).status).toBe(
        HTTP_STATUS.NOT_FOUND
      );
      expect((await axios.head(share.url, anyStatus)).status).toBe(
        HTTP_STATUS.NOT_FOUND
      );
    });
  });

  describe("access logs", () => {
    it("records a presigned download", async () => {
      const res = await axios.get(await presign(admin, "read"), anyStatus);
      expect(res.status).toBe(HTTP_STATUS.OK);
      const row = await waitForAccessLog({
        requestId: res.headers["x-request-id"],
      });
      expect(row).toMatchObject({
        bucketId: bucket.id,
        objectId,
        operation: "PRESIGNED_DOWNLOAD",
        statusCode: 200,
      });
    });

    it("records a presigned upload", async () => {
      const id = await uploadTestObjectAndGetId(
        admin,
        bucket.name,
        `logs/${randomUUID()}.txt`,
        createTestFile("before")
      );
      const res = await put(await presign(admin, "write", id), "after");
      expect(res.status).toBe(HTTP_STATUS.OK);
      const row = await waitForAccessLog({
        requestId: res.headers["x-request-id"],
      });
      expect(row).toMatchObject({
        bucketId: bucket.id,
        objectId: id,
        operation: "PRESIGNED_UPLOAD",
        statusCode: 200,
      });
    });

    it("records an archive download", async () => {
      const archive = await createArchive(admin);
      const res = await axios.get(archive.url, anyStatus);
      expect(res.status).toBe(HTTP_STATUS.OK);
      const row = await waitForAccessLog({
        requestId: res.headers["x-request-id"],
      });
      expect(row).toMatchObject({
        bucketId: bucket.id,
        operation: "ARCHIVE_DOWNLOAD",
        statusCode: 200,
      });
    });

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
