// @module-tag int
// @module-tag files
// @module-tag security
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  ensureTestMembership,
  getTestPrincipalToken,
} from "../../../../../../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  grantTestPermission,
  uploadTestObject,
  uploadTestObjectAndGetId,
} from "../../../../../../support/files.js";

describe("GET and POST /v1/files/buckets/:name/shares", () => {
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
        const otherBucket = await createTestBucket(token, {
          policy: "private",
        });
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
        expect(res.data.error).toBe("invalid_request");
        expect(res.data.error_description).toEqual(expect.any(String));
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
        expect(res.data.error).toBe("invalid_request");
        expect(res.data.error_description).toEqual(expect.any(String));
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
            {
              kind: "OBJECT",
              objectId: id,
              ...(expiresAt ? { expiresAt } : {}),
            },
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
          expect([sortDir, seen.sort()]).toEqual([
            sortDir,
            [...created].sort(),
          ]);
        }
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

    const versionedBucket = async () => {
      const bucket = await createTestBucket(token);
      const res = await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        { versioningEnabled: true },
        auth()
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      return bucket as { id: number; name: string };
    };

    const upload = (bucketName: string, key: string, body: string) =>
      uploadTestObject(
        token,
        bucketName,
        key,
        createTestFile(body, key.split("/").pop(), "text/plain")
      );

    const versions = (objectId: string) =>
      prisma.objectVersion.findMany({
        where: { objectId, deletedAt: null },
        orderBy: { createdAt: "asc" },
      });

    describe("shares", () => {
      it("refuses a share of a delete marker", async () => {
        const bucket = await versionedBucket();
        const obj = await upload(bucket.name, "s.txt", `s ${randomUUID()}`);
        await axios.delete(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}`,
          auth()
        );
        const [content, marker] = await versions(obj.id);
        expect(marker.isDeleteMarker).toBe(true);
        await axios.post(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}/versions/${content.id}/restore`,
          {},
          auth()
        );

        const res = await axios.post(
          `${BASE_URL}/buckets/${bucket.name}/shares`,
          { kind: "OBJECT", objectId: obj.id, versionId: marker.id },
          auth()
        );
        expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(res.data.error).toBe("cannot_share_delete_marker");
      });
    });
  });

  describe("Bucket ownership and active grants", () => {
    // Everything a bucket owner does, but no `file-service.admin`.
    const MEMBER = [
      "file-service.buckets.delete",
      "file-service.objects.delete",
      "file-service.permissions.delete",
      "file-service.shares.delete",
    ];

    const ORG = "bucket-owner-access-org";

    const as = (token?: string) => ({
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      validateStatus: () => true,
    });

    /** A user in ORG holding MEMBER, and a token for it. */
    const member = async (permissions = MEMBER) => {
      const userId = randomUUID();
      await ensureTestMembership(userId, ORG);
      const token = await getTestPrincipalToken({
        userId,
        organizationId: ORG,
        permissions,
      });
      return { userId, token };
    };

    const grant = (
      token: string,
      bucketName: string,
      userId: string,
      flags: { canRead?: boolean; canWrite?: boolean; canDelete?: boolean }
    ) =>
      axios.post(
        `${BASE_URL}/buckets/${bucketName}/permissions`,
        {
          userId,
          canRead: flags.canRead ?? false,
          canWrite: flags.canWrite ?? false,
          canDelete: flags.canDelete ?? false,
        },
        as(token)
      );

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("shares on a public bucket", () => {
      it("are managed only with a grant", async () => {
        const owner = await member();
        const stranger = await member();
        const bucket = await createTestBucket(owner.token, {
          policy: "public",
        });
        const object = await uploadTestObject(
          owner.token,
          bucket.name,
          "pub.txt",
          createTestFile("pub")
        );
        const sharesUrl = `${BASE_URL}/buckets/${bucket.name}/shares`;
        const share = await axios.post(
          sharesUrl,
          { kind: "OBJECT", objectId: object.id },
          as(owner.token)
        );
        expect(share.status).toBe(HTTP_STATUS.CREATED);

        // Anyone may download from the bucket; that is not a grant.
        const download = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/pub.txt`,
          as(stranger.token)
        );
        expect(download.status).toBe(HTTP_STATUS.OK);

        const create = await axios.post(
          sharesUrl,
          { kind: "OBJECT", objectId: object.id },
          as(stranger.token)
        );
        expect(create.status).toBe(HTTP_STATUS.FORBIDDEN);
        expect((await axios.get(sharesUrl, as(stranger.token))).status).toBe(
          HTTP_STATUS.FORBIDDEN
        );
        expect(
          (
            await axios.get(
              `${sharesUrl}/by-id/${share.data.id}`,
              as(stranger.token)
            )
          ).status
        ).toBe(HTTP_STATUS.FORBIDDEN);

        await grant(owner.token, bucket.name, stranger.userId, {
          canRead: true,
        });
        expect((await axios.get(sharesUrl, as(stranger.token))).status).toBe(
          HTTP_STATUS.OK
        );
      });
    });
  });

  describe("Bucket access", () => {
    // Everything a bucket creator does here, but no `file-service.admin`: object
    // access has to come from the creator's grant.
    const MEMBER = [
      "file-service.buckets.delete",
      "file-service.objects.delete",
      "file-service.permissions.delete",
      "file-service.shares.delete",
    ];

    const ORG = "bucket-access-org";

    const as = (token?: string) => ({
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      validateStatus: () => true,
    });

    // A grant in an organization's bucket goes to a member of it.
    const grantInOrg = async (
      token: string,
      bucketName: string,
      userId: string,
      flags: { canRead?: boolean; canWrite?: boolean; canDelete?: boolean }
    ) => {
      await ensureTestMembership(userId, ORG);
      return await grantTestPermission(token, bucketName, userId, flags);
    };
    let creatorId: string;
    let creatorToken: string;

    beforeAll(async () => {
      creatorId = randomUUID();
      creatorToken = await getTestPrincipalToken({
        userId: creatorId,
        organizationId: ORG,
        permissions: MEMBER,
      });
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("share tokens", () => {
      it("are shown on list and get only to the share's creator and the bucket's writers", async () => {
        const bucket = await createTestBucket(creatorToken);
        const object = await uploadTestObject(
          creatorToken,
          bucket.name,
          "doc.txt",
          createTestFile("hello")
        );
        const sharesUrl = `${BASE_URL}/buckets/${bucket.name}/shares`;

        const readerId = randomUUID();
        const reader = await getTestPrincipalToken({
          userId: readerId,
          organizationId: ORG,
          permissions: MEMBER,
        });
        await grantInOrg(creatorToken, bucket.name, readerId, {
          canRead: true,
        });
        const writerId = randomUUID();
        const writer = await getTestPrincipalToken({
          userId: writerId,
          organizationId: ORG,
          permissions: MEMBER,
        });
        await grantInOrg(creatorToken, bucket.name, writerId, {
          canRead: true,
          canWrite: true,
        });

        const theirs = await axios.post(
          sharesUrl,
          { kind: "OBJECT", objectId: object.id },
          as(creatorToken)
        );
        const mine = await axios.post(
          sharesUrl,
          { kind: "OBJECT", objectId: object.id },
          as(reader)
        );
        expect(mine.status).toBe(HTTP_STATUS.CREATED);
        expect(mine.data.token).toEqual(expect.any(String));
        expect(mine.data.url).toEqual(expect.any(String));

        const tokensSeenBy = async (token: string) => {
          const list = await axios.get(sharesUrl, as(token));
          expect(list.status).toBe(HTTP_STATUS.OK);
          const byId = Object.fromEntries(
            (
              list.data.data as { id: string; token: unknown; url: unknown }[]
            ).map((s) => [s.id, { token: s.token, url: s.url }])
          );
          const get = await axios.get(
            `${sharesUrl}/by-id/${theirs.data.id}`,
            as(token)
          );
          expect(get.status).toBe(HTTP_STATUS.OK);
          return {
            theirs: byId[theirs.data.id],
            mine: byId[mine.data.id],
            get: { token: get.data.token, url: get.data.url },
          };
        };

        const revealed = { token: theirs.data.token, url: theirs.data.url };
        expect(await tokensSeenBy(reader)).toEqual({
          theirs: { token: null, url: null },
          mine: { token: mine.data.token, url: mine.data.url },
          get: { token: null, url: null },
        });
        expect(await tokensSeenBy(creatorToken)).toEqual({
          theirs: revealed,
          mine: { token: mine.data.token, url: mine.data.url },
          get: revealed,
        });
        expect(await tokensSeenBy(writer)).toEqual({
          theirs: revealed,
          mine: { token: mine.data.token, url: mine.data.url },
          get: revealed,
        });
      });
    });
  });
});
