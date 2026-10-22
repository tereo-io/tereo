// @module-tag int
// @module-tag files
// @module-tag race
import { getTestPrincipalToken } from "../../../../../../../../support/principals.js";
import { prisma } from "../../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import axios from "axios";
import http from "http";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  getTestUserId,
  grantTestPermission,
  uploadTestObject,
  uploadTestObjectAndGetId,
  waitFor,
} from "../../../../../../../../support/files.js";

describe("GET, HEAD and PUT /v1/files/signed/objects/:bucket/by-id/:id", () => {
  describe("signed URLs", () => {
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
        prisma.user.update({
          where: { id: userId },
          data: { isActive: false },
        });

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

        expect((await axios.get(readUrl, anyStatus)).status).toBe(
          HTTP_STATUS.OK
        );
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
        expect((await put(writeUrl, "after")).status).toBe(
          HTTP_STATUS.FORBIDDEN
        );
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

  describe("streamed uploads with a parseable Content-Type", () => {
    // A body whose Content-Type a JSON or form parser would match must still be
    // stored byte for byte by the streamed upload routes.
    const BODIES = [
      { contentType: "application/json", body: '{"hello":"world"}' },
      { contentType: "application/x-www-form-urlencoded", body: "a=1&b=2" },
    ];
    let token: string;
    const auth = () => ({ Authorization: `Bearer ${token}` });

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    const download = async (bucket: string, key: string) => {
      const res = await axios.get<ArrayBuffer>(
        `${BASE_URL}/buckets/${bucket}/objects/${key}`,
        { headers: auth(), responseType: "arraybuffer" }
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      return Buffer.from(res.data).toString();
    };

    it.each(BODIES)(
      "stores a presigned PUT's bytes ($contentType)",
      async ({ contentType, body }) => {
        const bucket = await createTestBucket(token);
        const original = await uploadTestObject(
          token,
          bucket.name,
          "doc.json",
          createTestFile("first", "doc.json", "text/plain")
        );
        const presign = await axios.post<{ url: string }>(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${original.id}/presign`,
          { operation: "write", expiresInSeconds: 60 },
          { headers: auth() }
        );

        const put = await axios.put(presign.data.url, body, {
          headers: { "Content-Type": contentType },
          transformRequest: (data) => data,
          validateStatus: () => true,
        });
        expect([HTTP_STATUS.OK, HTTP_STATUS.CREATED]).toContain(put.status);
        expect(await download(bucket.name, "doc.json")).toBe(body);
      }
    );
  });

  describe("presigned write to an object changed while its body streams", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

    const presignWrite = async (bucketName: string, objectId: string) => {
      const presign = await axios.post<{ url: string }>(
        `${BASE_URL}/buckets/${bucketName}/objects/by-id/${objectId}/presign`,
        { operation: "write", expiresInSeconds: 300 },
        auth()
      );
      expect(presign.status).toBe(200);
      return new URL(presign.data.url);
    };

    // Sends the first bytes, runs `meanwhile` once the handler is reading the
    // body, then sends the rest.
    const putInTwoParts = (
      url: URL,
      body: string,
      meanwhile: () => Promise<void>
    ) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          url,
          {
            method: "PUT",
            headers: {
              "Content-Type": "text/plain",
              "Transfer-Encoding": "chunked",
            },
          },
          (res) => {
            let data = "";
            res.setEncoding("utf8");
            res.on("data", (c: string) => (data += c));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, body: data })
            );
          }
        );
        req.on("error", reject);
        req.write(body.slice(0, 4));
        (async () => {
          await sleep(500);
          await meanwhile();
          req.end(body.slice(4));
        })().catch(reject);
      });

    it("writes to the signed object under its new key, not to the object that took its old key", async () => {
      const bucket = await createTestBucket(token);
      const cBody = `C ${randomUUID()}`;
      const a = await uploadTestObject(
        token,
        bucket.name,
        "a.txt",
        createTestFile(`A ${randomUUID()}`)
      );
      const c = await uploadTestObject(
        token,
        bucket.name,
        "c.txt",
        createTestFile(cBody)
      );
      const url = await presignWrite(bucket.name, a.id);

      const written = `new ${randomUUID()}`;
      const res = await putInTwoParts(url, written, async () => {
        const r1 = await axios.patch(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${a.id}`,
          { objectKey: "b.txt" },
          auth()
        );
        const r2 = await axios.patch(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${c.id}`,
          { objectKey: "a.txt" },
          auth()
        );
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ id: a.id, key: "b.txt" });

      const cDownload = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/a.txt`,
        { ...auth(), responseType: "text" }
      );
      expect(cDownload.headers["x-object-id"]).toBe(c.id);
      expect(cDownload.data).toBe(cBody);

      const aDownload = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/b.txt`,
        { ...auth(), responseType: "text" }
      );
      expect(aDownload.headers["x-object-id"]).toBe(a.id);
      expect(aDownload.data).toBe(written);
    });

    it("answers 404 and creates nothing when the object is deleted meanwhile", async () => {
      const bucket = await createTestBucket(token);
      const a = await uploadTestObject(
        token,
        bucket.name,
        "a.txt",
        createTestFile(`A ${randomUUID()}`)
      );
      const url = await presignWrite(bucket.name, a.id);

      const res = await putInTwoParts(url, `new ${randomUUID()}`, async () => {
        const del = await axios.delete(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${a.id}`,
          auth()
        );
        expect(del.status).toBe(204);
      });
      expect(res.status).toBe(404);

      const live = await prisma.object.count({
        where: { bucketId: bucket.id, objectKey: "a.txt", deletedAt: null },
      });
      expect(live).toBe(0);
    });
  });
});
