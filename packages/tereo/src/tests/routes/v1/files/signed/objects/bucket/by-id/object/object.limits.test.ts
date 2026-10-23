// @module-tag int
// @module-tag files
import { prisma } from "../../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
} from "../../../../../../../../support/files.js";

describe("GET and HEAD /v1/files/signed/objects/:bucket/by-id/:id", () => {
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
          {
            kind: "OBJECT",
            objectId,
            maxDownloads: 1,
            password: "open-sesame",
          },
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
  });

  describe("signed URLs", () => {
    const anyStatus = { validateStatus: () => true, maxRedirects: 0 };
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
    });

    describe("a capped share's nonce", { tags: ["race"] }, () => {
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
        expect(statuses.sort()).toEqual([
          HTTP_STATUS.OK,
          HTTP_STATUS.FORBIDDEN,
        ]);
      });
    });
  });
});
