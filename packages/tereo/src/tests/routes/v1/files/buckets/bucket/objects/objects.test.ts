// @module-tag int
// @module-tag files
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import FormData from "form-data";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  getTestUserId,
  testIdempotencyKey,
  uploadTestObject,
} from "../../../../../../support/files.js";

describe("GET /v1/files/buckets/:name/objects and /objects/prefixes, POST /objects/bulk-delete and /objects/purge-non-current-versions", () => {
  describe("Object Management", () => {
    interface ObjectResponse {
      id: string;
      key: string;
      contentType: string;
      sizeBytes: string;
      etag: string;
      metadata?: Record<string, unknown>;
      createdAt: string;
      updatedAt?: string;
    }

    interface ObjectsListResponse {
      data: ObjectResponse[];
      hasMore: boolean;
      limit: number;
      nextCursor: string | null;
    }
    let testToken: string;
    let testBucket: { id: number; name: string; policy: string };

    beforeAll(async () => {
      testToken = await getTestAccessToken();
      testBucket = await createTestBucket(testToken, { policy: "private" });
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("GET /buckets/:name/objects", () => {
      it("should list objects in bucket", async () => {
        // Upload a few test objects
        const file = createTestFile("Test content", "test.txt", "text/plain");
        await uploadTestObject(
          testToken,
          testBucket.name,
          "list-test-1.txt",
          file
        );
        await uploadTestObject(
          testToken,
          testBucket.name,
          "list-test-2.txt",
          file
        );

        const response = await axios.get<ObjectsListResponse>(
          `${BASE_URL}/buckets/${testBucket.name}/objects`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        const data = response.data;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.data).toBeDefined();
        expect(Array.isArray(data.data)).toBe(true);
        expect(data.hasMore).toBeDefined();
        expect(data.nextCursor !== undefined).toBe(true);
        expect(data.data.length).toBeGreaterThan(0);
      });

      it("should support cursor pagination", async () => {
        const response = await axios.get<ObjectsListResponse>(
          `${BASE_URL}/buckets/${testBucket.name}/objects?limit=5`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        const data = response.data;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.limit).toBe(5);
        expect(
          data.nextCursor === null || typeof data.nextCursor === "string"
        ).toBe(true);
      });

      it("should support prefix filtering", async () => {
        const file = createTestFile("Test", "test.txt", "text/plain");
        await uploadTestObject(
          testToken,
          testBucket.name,
          "prefix/test-1.txt",
          file
        );
        await uploadTestObject(
          testToken,
          testBucket.name,
          "prefix/test-2.txt",
          file
        );
        await uploadTestObject(
          testToken,
          testBucket.name,
          "other/test.txt",
          file
        );

        const response = await axios.get<ObjectsListResponse>(
          `${BASE_URL}/buckets/${testBucket.name}/objects?filter[objectKey]=prefix/&filter[objectKey_op]=startsWith`,
          {
            headers: { Authorization: `Bearer ${testToken}` },
            validateStatus: () => true,
          }
        );

        const data = response.data;

        expect(response.status).toBe(HTTP_STATUS.OK);
        expect(data.data.every((obj) => obj.key.startsWith("prefix/"))).toBe(
          true
        );
      });

      it("should support compound filters on the same field (startsWith + contains)", async () => {
        const file = createTestFile("Test", "test.txt", "text/plain");
        await uploadTestObject(
          testToken,
          testBucket.name,
          "compound/invoice-jan.txt",
          file
        );
        await uploadTestObject(
          testToken,
          testBucket.name,
          "compound/invoice-feb.txt",
          file
        );
        await uploadTestObject(
          testToken,
          testBucket.name,
          "compound/receipt-jan.txt",
          file
        );
        await uploadTestObject(
          testToken,
          testBucket.name,
          "elsewhere/invoice-jan.txt",
          file
        );

        const url =
          `${BASE_URL}/buckets/${testBucket.name}/objects` +
          `?filter[objectKey]=${encodeURIComponent("compound/")}` +
          `&filter[objectKey_op]=startsWith` +
          `&filter[objectKey]=invoice` +
          `&filter[objectKey_op]=contains` +
          `&limit=100`;

        const response = await axios.get<ObjectsListResponse>(url, {
          headers: { Authorization: `Bearer ${testToken}` },
          validateStatus: () => true,
        });

        expect(response.status).toBe(HTTP_STATUS.OK);
        const keys = response.data.data.map((o) => o.key);
        expect(keys).toEqual(
          expect.arrayContaining([
            "compound/invoice-jan.txt",
            "compound/invoice-feb.txt",
          ])
        );
        expect(keys).not.toContain("compound/receipt-jan.txt");
        expect(keys).not.toContain("elsewhere/invoice-jan.txt");
      });
    });
  });

  describe("File Service Overhaul — end-to-end flows", () => {
    const authHeader = (token: string) => ({
      Authorization: `Bearer ${token}`,
    });
    let testToken: string;

    beforeAll(async () => {
      testToken = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("Prefixes endpoint (UI tree view)", () => {
      it("lists common prefixes and leaf objects under a prefix", async () => {
        const bucket = await createTestBucket(testToken, { policy: "private" });

        // Upload a small hierarchy
        await uploadTestObject(
          testToken,
          bucket.name,
          "docs/alpha.txt",
          createTestFile("aaaa", "alpha.txt", "text/plain")
        );
        await uploadTestObject(
          testToken,
          bucket.name,
          "docs/bravo.txt",
          createTestFile("bbbb", "bravo.txt", "text/plain")
        );
        await uploadTestObject(
          testToken,
          bucket.name,
          "images/cat.png",
          createTestFile("cccc", "cat.png", "image/png")
        );
        await uploadTestObject(
          testToken,
          bucket.name,
          "top-level.md",
          createTestFile("dddd", "top-level.md", "text/markdown")
        );

        const res = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/prefixes`,
          {
            headers: authHeader(testToken),
            params: { prefix: "", delimiter: "/" },
          }
        );

        expect(res.status).toBe(HTTP_STATUS.OK);
        const prefixNames = res.data.data
          .filter((e: { type: string }) => e.type === "prefix")
          .map((p: { prefix: string }) => p.prefix);
        expect(prefixNames).toContain("docs/");
        expect(prefixNames).toContain("images/");
        const leafKeys = res.data.data
          .filter((e: { type: string }) => e.type === "object")
          .map((o: { key: string }) => o.key);
        expect(leafKeys).toContain("top-level.md");
        expect(leafKeys).not.toContain("docs/alpha.txt"); // not a leaf at this level
      });

      it("drills into a prefix and returns its direct children", async () => {
        const bucket = await createTestBucket(testToken, { policy: "private" });
        await uploadTestObject(
          testToken,
          bucket.name,
          "feeds/in/1.csv",
          createTestFile("x", "1.csv", "text/csv")
        );
        await uploadTestObject(
          testToken,
          bucket.name,
          "feeds/in/2.csv",
          createTestFile("y", "2.csv", "text/csv")
        );
        await uploadTestObject(
          testToken,
          bucket.name,
          "feeds/out/3.csv",
          createTestFile("z", "3.csv", "text/csv")
        );

        const res = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/prefixes`,
          {
            headers: authHeader(testToken),
            params: { prefix: "feeds/", delimiter: "/" },
          }
        );
        expect(res.status).toBe(HTTP_STATUS.OK);
        const prefixNames = res.data.data
          .filter((e: { type: string }) => e.type === "prefix")
          .map((p: { prefix: string }) => p.prefix);
        expect(prefixNames).toEqual(
          expect.arrayContaining(["feeds/in/", "feeds/out/"])
        );
      });

      it("groups by a delimiter longer than one character", async () => {
        const bucket = await createTestBucket(testToken, { policy: "private" });
        await uploadTestObject(
          testToken,
          bucket.name,
          "a--b.txt",
          createTestFile("x", "b.txt", "text/plain")
        );
        await uploadTestObject(
          testToken,
          bucket.name,
          "plain.txt",
          createTestFile("y", "plain.txt", "text/plain")
        );

        const res = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/prefixes`,
          {
            headers: authHeader(testToken),
            params: { prefix: "", delimiter: "--" },
          }
        );
        expect(res.status).toBe(HTTP_STATUS.OK);
        const prefixNames = res.data.data
          .filter((e: { type: string }) => e.type === "prefix")
          .map((p: { prefix: string }) => p.prefix);
        expect(prefixNames).toEqual(["a--"]);
        const leafKeys = res.data.data
          .filter((e: { type: string }) => e.type === "object")
          .map((o: { key: string }) => o.key);
        expect(leafKeys).toEqual(["plain.txt"]);
      });
    });

    describe("Undelete by restoring a version", () => {
      const versionedBucket = async () => {
        const bucket = await createTestBucket(testToken, { policy: "private" });
        await axios.put(
          `${BASE_URL}/buckets/${bucket.name}`,
          { versioningEnabled: true },
          {
            headers: {
              ...authHeader(testToken),
              "Content-Type": "application/json",
            },
          }
        );
        return bucket as { id: number; name: string };
      };

      // Uploads one version under `key`, deletes the object (a delete marker
      // in a versioned bucket) and returns its id and the content version.
      const deletedObject = async (bucketName: string, key: string) => {
        const uploaded = await uploadTestObject(
          testToken,
          bucketName,
          key,
          createTestFile("original", key, "text/plain")
        );
        const versions = await axios.get(
          `${BASE_URL}/buckets/${bucketName}/objects/by-id/${uploaded.id}/versions`,
          { headers: authHeader(testToken) }
        );
        const versionId = versions.data.data[0].versionId as string;
        const del = await axios.delete(
          `${BASE_URL}/buckets/${bucketName}/objects/by-id/${uploaded.id}`,
          { headers: authHeader(testToken) }
        );
        expect(del.status).toBe(HTTP_STATUS.NO_CONTENT);
        return { id: uploaded.id, versionId };
      };

      const restore = (
        bucketName: string,
        id: string,
        versionId: string,
        token = testToken
      ) =>
        axios.post(
          `${BASE_URL}/buckets/${bucketName}/objects/by-id/${id}/versions/${versionId}/restore`,
          {},
          { headers: authHeader(token), validateStatus: () => true }
        );

      const listObjects = (bucketName: string, query: string) =>
        axios.get(`${BASE_URL}/buckets/${bucketName}/objects?${query}`, {
          headers: authHeader(testToken),
          validateStatus: () => true,
        });

      it("lists deleted objects with deleted=true, until one is restored", async () => {
        const bucket = await versionedBucket();
        const { id, versionId } = await deletedObject(
          bucket.name,
          "gone/a.txt"
        );
        await deletedObject(bucket.name, "gone/b.txt");
        const live = await uploadTestObject(
          testToken,
          bucket.name,
          "live.txt",
          createTestFile("live", "live.txt", "text/plain")
        );

        const plain = await listObjects(bucket.name, "");
        expect(plain.data.data.map((o: { id: string }) => o.id)).toEqual([
          live.id,
        ]);

        const deleted = await listObjects(
          bucket.name,
          "deleted=true&sort=objectKey&sortDir=asc&limit=1"
        );
        expect(deleted.status).toBe(HTTP_STATUS.OK);
        expect(deleted.data.data).toEqual([
          {
            id,
            key: "gone/a.txt",
            deletedAt: expect.any(String),
            deletedBy: getTestUserId(),
            deletedByUser: {
              id: getTestUserId(),
              email: expect.any(String),
              name: expect.anything(),
            },
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
          },
        ]);
        expect(deleted.data.hasMore).toBe(true);

        const next = await listObjects(
          bucket.name,
          `deleted=true&sort=objectKey&sortDir=asc&limit=1&cursor=${encodeURIComponent(deleted.data.nextCursor)}`
        );
        expect(next.data.data.map((o: { key: string }) => o.key)).toEqual([
          "gone/b.txt",
        ]);
        expect(next.data.hasMore).toBe(false);

        const filtered = await listObjects(
          bucket.name,
          "deleted=true&filter[objectKey]=b.txt&filter[objectKey_op]=contains"
        );
        expect(filtered.data.data.map((o: { key: string }) => o.key)).toEqual([
          "gone/b.txt",
        ]);

        expect((await restore(bucket.name, id, versionId)).status).toBe(
          HTTP_STATUS.CREATED
        );
        const after = await listObjects(bucket.name, "deleted=true");
        expect(after.data.data.map((o: { key: string }) => o.key)).toEqual([
          "gone/b.txt",
        ]);
      });

      it("refuses deleted=true with a sizeBytes sort, or a value other than true or false", async () => {
        const bucket = await versionedBucket();
        expect(
          (await listObjects(bucket.name, "deleted=true&sort=sizeBytes")).status
        ).toBe(HTTP_STATUS.BAD_REQUEST);
        expect((await listObjects(bucket.name, "deleted=yes")).status).toBe(
          HTTP_STATUS.BAD_REQUEST
        );
      });

      it("lists nothing deleted in a bucket without versioning, which keeps no version to restore", async () => {
        const bucket = await createTestBucket(testToken, { policy: "private" });
        const uploaded = await uploadTestObject(
          testToken,
          bucket.name,
          "plain.txt",
          createTestFile("x", "plain.txt", "text/plain")
        );
        await axios.delete(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${uploaded.id}`,
          { headers: authHeader(testToken) }
        );
        const res = await listObjects(bucket.name, "deleted=true");
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(res.data.data).toEqual([]);
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

    describe("prefixes are literal", () => {
      it("bulk delete by prefix treats _ and % as characters", async () => {
        const bucket = await createTestBucket(token);
        await upload(bucket.name, "a_1.txt", `x ${randomUUID()}`);
        await upload(bucket.name, "ab1.txt", `y ${randomUUID()}`);

        const res = await axios.post(
          `${BASE_URL}/buckets/${bucket.name}/objects/bulk-delete`,
          { prefix: "a_" },
          auth()
        );
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(res.data.deletedCount).toBe(1);

        const wildcard = await axios.post(
          `${BASE_URL}/buckets/${bucket.name}/objects/bulk-delete`,
          { prefix: "%" },
          auth()
        );
        expect(wildcard.data.deletedCount).toBe(0);

        const live = await prisma.object.findMany({
          where: { bucketId: bucket.id, deletedAt: null },
        });
        expect(live.map((o) => o.objectKey)).toEqual(["ab1.txt"]);
      });

      it("the prefix listing treats _ as a character", async () => {
        const bucket = await createTestBucket(token);
        await upload(bucket.name, "a_1.txt", `x ${randomUUID()}`);
        await upload(bucket.name, "abc/2.txt", `y ${randomUUID()}`);

        const res = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/prefixes`,
          { ...auth(), params: { prefix: "a_" } }
        );
        expect(res.status).toBe(HTTP_STATUS.OK);
        expect(res.data.data).toEqual([
          expect.objectContaining({ type: "object", key: "a_1.txt" }),
        ]);
      });
    });

    it("pages through prefixes without listing a finished set again", async () => {
      const bucket = await createTestBucket(token);
      for (const key of [
        "d1/x.txt",
        "d2/x.txt",
        "o1.txt",
        "o2.txt",
        "o3.txt",
      ]) {
        await upload(bucket.name, key, `${key} ${randomUUID()}`);
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const res = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/prefixes`,
          { ...auth(), params: { limit: 2, ...(cursor ? { cursor } : {}) } }
        );
        expect(res.status).toBe(HTTP_STATUS.OK);
        for (const e of res.data.data as { prefix?: string; key?: string }[]) {
          seen.push(e.prefix ?? e.key!);
        }
        if (!res.data.hasMore) break;
        cursor = res.data.nextCursor;
      }
      expect(seen.sort()).toEqual(["d1/", "d2/", "o1.txt", "o2.txt", "o3.txt"]);
    });
  });

  describe("Bulk deletes", () => {
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

    it("refuses an empty prefix and a body with both forms", async () => {
      const bucket = await createTestBucket(token);
      const url = `${BASE_URL}/buckets/${bucket.name}/objects/bulk-delete`;
      for (const body of [{ prefix: "" }, { prefix: "a/", ids: [] }, {}]) {
        const res = await axios.post(url, body, auth());
        expect([body, res.status]).toEqual([body, HTTP_STATUS.BAD_REQUEST]);
        expect(res.data.error).toBe("invalid_request");
        expect(res.data.error_description).toEqual(expect.any(String));
      }
    });

    it("purges non-current versions and keeps the current one", async () => {
      const v2 = `v2 ${randomUUID()}`;
      const bucket = await createTestBucket(token);
      await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        { versioningEnabled: true },
        auth()
      );
      await uploadTestObject(
        token,
        bucket.name,
        "doc.txt",
        createTestFile(`v1 ${randomUUID()}`)
      );
      const object = await uploadTestObject(
        token,
        bucket.name,
        "doc.txt",
        createTestFile(v2)
      );

      const res = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/objects/purge-non-current-versions`,
        {},
        auth()
      );
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.data).toMatchObject({ purgedCount: 1, truncated: false });

      const versions = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${object.id}/versions`,
        auth()
      );
      expect(versions.data.data).toHaveLength(1);
      expect(versions.data.data[0].isCurrent).toBe(true);
      const download = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/doc.txt`,
        auth()
      );
      expect(download.data).toBe(v2);
    });
  });

  describe("object write lock order", { tags: ["race"] }, () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

    const lockBucket = (bucketId: number) => (tx: Tx) =>
      tx.$queryRaw`SELECT 1 FROM "files"."buckets" WHERE "id" = ${bucketId} FOR UPDATE`;
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

    const putObject = (bucketName: string, key: string, body: string) => {
      const form = new FormData();
      form.append("file", Buffer.from(body), {
        filename: "o.txt",
        contentType: "text/plain",
      });
      return axios.put(
        `${BASE_URL}/buckets/${bucketName}/objects/${key}`,
        form,
        {
          headers: {
            ...auth().headers,
            "Idempotency-Key": testIdempotencyKey(),
            ...form.getHeaders(),
          },
          validateStatus: () => true,
        }
      );
    };

    const versionedObject = async () => {
      const bucket = (await createTestBucket(token)) as {
        id: number;
        name: string;
      };
      await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        { versioningEnabled: true },
        auth()
      );
      const firstBody = `v1 ${randomUUID()}`;
      const obj = await uploadTestObject(
        token,
        bucket.name,
        "o.txt",
        createTestFile(firstBody)
      );
      await uploadTestObject(
        token,
        bucket.name,
        "o.txt",
        createTestFile(`v2 ${randomUUID()}`)
      );
      const [first] = await prisma.objectVersion.findMany({
        where: { objectId: obj.id, deletedAt: null },
        orderBy: { createdAt: "asc" },
      });
      return { bucket, objectId: obj.id, first, firstBody };
    };

    describe("releasing a version's ref locks the bucket before the blob", () => {
      /**
       * Queues an upload of `firstBody` and then `release` behind a held bucket
       * lock: the upload waits for the bucket first, so it takes the bucket
       * before the blob both write once the lock is let go.
       */
      const raceUploadOfReleasedContent = async <T>(
        bucket: { id: number; name: string },
        firstBody: string,
        release: () => Promise<T>
      ) => {
        let upload!: ReturnType<typeof putObject>;
        let released!: Promise<T>;
        await prisma.$transaction(
          async (tx) => {
            await lockBucket(bucket.id)(tx);
            upload = putObject(bucket.name, "copy.txt", firstBody);
            await sleep(1000);
            released = release();
            await sleep(1000);
          },
          { timeout: 30_000 }
        );
        return await Promise.all([upload, released]);
      };

      it("a history purge and an upload of its content both complete", async () => {
        const { bucket, firstBody } = await versionedObject();

        const [upload, purge] = await raceUploadOfReleasedContent(
          bucket,
          firstBody,
          () =>
            axios.post(
              `${BASE_URL}/buckets/${bucket.name}/objects/purge-non-current-versions`,
              {},
              auth()
            )
        );

        expect(upload.status).toBe(HTTP_STATUS.CREATED);
        expect(purge.status).toBe(HTTP_STATUS.OK);
      });
    });
  });
});
