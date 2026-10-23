// @module-tag int
// @module-tag files
import { prisma } from "../../../../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  FIXTURE_ORGANIZATION_IDS,
  getTestPrincipalToken,
} from "../../../../../../../../../../support/principals.js";
import {
  cleanupTestEntities as cleanupWebhookEntities,
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../../../../../../../support/webhooks.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  grantTestPermission,
  uploadTestObject,
} from "../../../../../../../../../../support/files.js";

describe("POST /v1/files/buckets/:name/objects/by-id/:id/versions/:versionId/restore and GET /download", () => {
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

      it("brings a deleted object back under its key and id, and audits it", async () => {
        const bucket = await versionedBucket();
        const key = "undelete-me.txt";
        const { id, versionId } = await deletedObject(bucket.name, key);

        const gone = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/${key}`,
          { headers: authHeader(testToken), validateStatus: () => true }
        );
        expect(gone.status).toBe(HTTP_STATUS.NOT_FOUND);

        const res = await restore(bucket.name, id, versionId);
        expect(res.status).toBe(HTTP_STATUS.CREATED);

        const dl = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/${key}`,
          { headers: authHeader(testToken) }
        );
        expect(dl.data).toBe("original");
        const byKey = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-key/${key}`,
          { headers: authHeader(testToken) }
        );
        expect(byKey.data.id).toBe(id);

        const versions = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${id}/versions`,
          { headers: authHeader(testToken) }
        );
        const current = versions.data.data.filter(
          (v: { isCurrent: boolean }) => v.isCurrent
        );
        expect(current).toHaveLength(1);
        expect(current[0]).toMatchObject({
          versionId: res.data.versionId,
          isDeleteMarker: false,
          restoredFromVersionId: versionId,
        });
        // The delete marker stays in history.
        expect(
          versions.data.data.some(
            (v: { isDeleteMarker: boolean }) => v.isDeleteMarker
          )
        ).toBe(true);

        const object = await prisma.object.findUniqueOrThrow({ where: { id } });
        expect(object.deletedAt).toBeNull();
        expect(object.deletedBy).toBeNull();

        const audit = await prisma.auditLogEntry.findFirst({
          where: { entityType: "objectVersion", entityId: res.data.versionId },
        });
        expect(audit).toMatchObject({
          action: "CREATE",
          metadata: { restoredFromVersionId: versionId, undeleted: true },
        });
      });

      it("marks an ordinary restore as not undeleted", async () => {
        const bucket = await versionedBucket();
        const key = "plain-restore.txt";
        const v1 = await uploadTestObject(
          testToken,
          bucket.name,
          key,
          createTestFile("one", key, "text/plain")
        );
        const versions = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${v1.id}/versions`,
          { headers: authHeader(testToken) }
        );
        const firstVersionId = versions.data.data[0].versionId as string;
        await uploadTestObject(
          testToken,
          bucket.name,
          key,
          createTestFile("two", key, "text/plain")
        );

        const res = await restore(bucket.name, v1.id, firstVersionId);
        expect(res.status).toBe(HTTP_STATUS.CREATED);
        const audit = await prisma.auditLogEntry.findFirst({
          where: { entityType: "objectVersion", entityId: res.data.versionId },
        });
        expect(audit?.metadata).toMatchObject({ undeleted: false });
      });

      it("clears an expiry that passed while the object was deleted", async () => {
        const bucket = await versionedBucket();
        const { id, versionId } = await deletedObject(bucket.name, "ttl.txt");
        await prisma.object.update({
          where: { id },
          data: { deleteAfter: new Date(Date.now() - 60_000) },
        });

        const res = await restore(bucket.name, id, versionId);
        expect(res.status).toBe(HTTP_STATUS.CREATED);
        const object = await prisma.object.findUniqueOrThrow({ where: { id } });
        expect(object.deleteAfter).toBeNull();
      });

      it("keeps an expiry that is still ahead", async () => {
        const bucket = await versionedBucket();
        const { id, versionId } = await deletedObject(bucket.name, "ttl2.txt");
        const later = new Date(Date.now() + 86_400_000);
        await prisma.object.update({
          where: { id },
          data: { deleteAfter: later },
        });

        const res = await restore(bucket.name, id, versionId);
        expect(res.status).toBe(HTTP_STATUS.CREATED);
        const object = await prisma.object.findUniqueOrThrow({ where: { id } });
        expect(object.deleteAfter?.getTime()).toBe(later.getTime());
      });

      it("409s when another object has taken the key since the delete", async () => {
        const bucket = await versionedBucket();
        const key = "taken.txt";
        const { id, versionId } = await deletedObject(bucket.name, key);
        const replacement = await uploadTestObject(
          testToken,
          bucket.name,
          key,
          createTestFile("replacement", key, "text/plain")
        );
        expect(replacement.id).not.toBe(id);

        const res = await restore(bucket.name, id, versionId);
        expect(res.status).toBe(HTTP_STATUS.CONFLICT);
        expect(res.data.error).toBe("conflict");

        const dl = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/${key}`,
          { headers: authHeader(testToken) }
        );
        expect(dl.data).toBe("replacement");
        const object = await prisma.object.findUniqueOrThrow({ where: { id } });
        expect(object.deletedAt).not.toBeNull();
      });

      it("still refuses to restore the delete marker itself", async () => {
        const bucket = await versionedBucket();
        const { id } = await deletedObject(bucket.name, "marker.txt");
        const versions = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${id}/versions`,
          { headers: authHeader(testToken) }
        );
        const marker = versions.data.data.find(
          (v: { isDeleteMarker: boolean }) => v.isDeleteMarker
        );

        const res = await restore(bucket.name, id, marker.versionId);
        expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
        expect(res.data.error).toBe("already_current");
      });

      it("needs objects.write and a bucket grant with canWrite", async () => {
        const bucket = await versionedBucket();
        const { id, versionId } = await deletedObject(bucket.name, "perm.txt");

        const principal = async (
          permissions: string[],
          grant: { canRead?: boolean; canWrite?: boolean }
        ) => {
          const userId = randomUUID();
          const token = await getTestPrincipalToken({
            userId,
            organizationId: null,
            permissions,
          });
          await grantTestPermission(testToken, bucket.name, userId, grant);
          return token;
        };

        const reader = await principal(["file-service.objects.read"], {
          canRead: true,
          canWrite: true,
        });
        expect((await restore(bucket.name, id, versionId, reader)).status).toBe(
          HTTP_STATUS.FORBIDDEN
        );

        const noGrant = await principal(["file-service.objects.write"], {
          canRead: true,
        });
        expect(
          (await restore(bucket.name, id, versionId, noGrant)).status
        ).toBe(HTTP_STATUS.FORBIDDEN);

        // Still deleted after the refusals.
        expect(
          (await prisma.object.findUniqueOrThrow({ where: { id } })).deletedAt
        ).not.toBeNull();

        const writer = await principal(["file-service.objects.write"], {
          canRead: true,
          canWrite: true,
        });
        expect((await restore(bucket.name, id, versionId, writer)).status).toBe(
          HTTP_STATUS.CREATED
        );
      });
    });

    describe("a version branched by PATCH", () => {
      const auth = () => ({
        headers: authHeader(testToken),
        validateStatus: () => true,
      });
      const usage = async (bucketId: number) =>
        (await prisma.bucket.findUniqueOrThrow({ where: { id: bucketId } }))
          .currentUsageBytes;

      it("a version branched by PATCH is charged, so deleting the old one leaves usage right", async () => {
        const bucket = await createTestBucket(testToken);
        const enabled = await axios.put(
          `${BASE_URL}/buckets/${bucket.name}`,
          { versioningEnabled: true },
          auth()
        );
        expect(enabled.status).toBe(HTTP_STATUS.OK);
        const body = `branch ${randomUUID()}`;
        const size = BigInt(Buffer.byteLength(body));
        const obj = await uploadTestObject(
          testToken,
          bucket.name,
          "b.txt",
          createTestFile(body, "b.txt", "text/plain")
        );
        expect(await usage(bucket.id)).toBe(size);

        const patch = await axios.patch(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}`,
          { tags: ["branched"], createNewVersion: true },
          auth()
        );
        expect(patch.status).toBe(HTTP_STATUS.OK);
        expect(await usage(bucket.id)).toBe(2n * size);

        const [old] = await prisma.objectVersion.findMany({
          where: { objectId: obj.id, deletedAt: null },
          orderBy: { createdAt: "asc" },
        });
        const del = await axios.delete(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}/versions/${old.id}`,
          auth()
        );
        expect(del.status).toBe(HTTP_STATUS.NO_CONTENT);
        expect(await usage(bucket.id)).toBe(size);
      });
    });

    describe("GET /objects/by-id/:id/versions/:versionId/download", () => {
      it("streams a specific version's bytes by id (survives rename)", async () => {
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

        const v1 = await uploadTestObject(
          testToken,
          bucket.name,
          "doc.txt",
          createTestFile("v1 bytes", "doc.txt", "text/plain")
        );
        await uploadTestObject(
          testToken,
          bucket.name,
          "doc.txt",
          createTestFile("v2 bytes", "doc.txt", "text/plain")
        );

        const versions = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${v1.id}/versions`,
          { headers: authHeader(testToken) }
        );
        const priorVersionId = versions.data.data.find(
          (v: { isCurrent: boolean }) => !v.isCurrent
        ).versionId;

        // Rename the object — the id-addressed download URL should still work.
        await axios.patch(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${v1.id}`,
          { objectKey: "renamed.txt" },
          {
            headers: {
              ...authHeader(testToken),
              "Content-Type": "application/json",
            },
          }
        );

        const dl = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${v1.id}/versions/${priorVersionId}/download`,
          { headers: authHeader(testToken), responseType: "text" }
        );
        expect(dl.status).toBe(HTTP_STATUS.OK);
        expect(dl.data).toBe("v1 bytes");
      });

      it("marks a private bucket's version download private", async () => {
        const bucket = await createTestBucket(testToken, { policy: "private" });
        await axios.put(
          `${BASE_URL}/buckets/${bucket.name}`,
          { versioningEnabled: true },
          { headers: { Authorization: `Bearer ${testToken}` } }
        );
        const object = await uploadTestObject(
          testToken,
          bucket.name,
          "a.txt",
          createTestFile(`a ${randomUUID()}`)
        );
        const base = `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${object.id}/versions`;
        const auth = { headers: { Authorization: `Bearer ${testToken}` } };
        const versions = await axios.get(base, auth);
        const versionId = versions.data.data[0].versionId;
        const res = await axios.get(`${base}/${versionId}/download`, auth);
        expect(res.headers["cache-control"]).toBe(
          "private, max-age=31536000, immutable"
        );
      });

      describe("preconditions", () => {
        let bucket: { id: number; name: string };
        let objectId: string;
        let firstVersion: { id: string; etag: string | null };

        const versionUrl = (versionId: string) =>
          `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${objectId}/versions/${versionId}/download`;

        beforeAll(async () => {
          bucket = await createTestBucket(testToken);
          await axios.put(
            `${BASE_URL}/buckets/${bucket.name}`,
            { versioningEnabled: true },
            { headers: authHeader(testToken) }
          );
          objectId = (
            await uploadTestObject(
              testToken,
              bucket.name,
              "doc.txt",
              createTestFile("first one", "a.txt")
            )
          ).id;
          await uploadTestObject(
            testToken,
            bucket.name,
            "doc.txt",
            createTestFile("second, longer", "a.txt")
          );
          const versions = await prisma.objectVersion.findMany({
            where: { objectId },
            orderBy: { createdAt: "asc" },
          });
          [firstVersion] = versions;
        });

        it("answers a version download's If-None-Match with 304 and its validators", async () => {
          const res = await axios.get(versionUrl(firstVersion.id), {
            headers: {
              ...authHeader(testToken),
              "If-None-Match": `W/"${firstVersion.etag}"`,
            },
            validateStatus: () => true,
          });
          expect(res.status).toBe(304);
          expect(res.headers.etag).toBe(`"${firstVersion.etag}"`);
          expect(res.headers["cache-control"]).toContain("immutable");
          expect(res.headers["last-modified"]).toBeDefined();
        });
      });

      describe("ranges", () => {
        it("serves ranges of a version by id", async () => {
          const content = Buffer.from(
            `${randomUUID()}${randomUUID()}${randomUUID()}`.slice(0, 100)
          );
          const versioned = await createTestBucket(testToken);
          await axios.put(
            `${BASE_URL}/buckets/${versioned.name}`,
            { versioningEnabled: true },
            { headers: authHeader(testToken) }
          );
          const obj = await uploadTestObject(
            testToken,
            versioned.name,
            "v.bin",
            {
              buffer: content,
              filename: "f.bin",
              contentType: "application/octet-stream",
            }
          );
          const version = await prisma.objectVersion.findFirstOrThrow({
            where: { objectId: obj.id, isCurrent: true },
          });
          const res = await axios.get<ArrayBuffer>(
            `${BASE_URL}/buckets/${versioned.name}/objects/by-id/${obj.id}/versions/${version.id}/download`,
            {
              headers: { ...authHeader(testToken), Range: "bytes=50-59" },
              responseType: "arraybuffer",
              validateStatus: () => true,
            }
          );
          expect(res.status).toBe(206);
          expect(Buffer.from(res.data)).toEqual(content.subarray(50, 60));
        });
      });
    });
  });

  describe("file-service webhook events", () => {
    const ORG_ID = FIXTURE_ORGANIZATION_IDS[0];

    const EVENT_TYPES = [
      "file-service.bucket.created",
      "file-service.bucket.updated",
      "file-service.bucket.owner-changed",
      "file-service.object.created",
      "file-service.object.updated",
      "file-service.object.version.created",
      "file-service.permission.granted",
      "file-service.permission.revoked",
      "file-service.multipart.completed",
      "file-service.multipart.aborted",
      "file-service.lifecycle.policy.updated",
      "file-service.lifecycle.policy.deleted",
    ];
    let token: string;
    let endpointId: string;

    const auth = () => ({ Authorization: `Bearer ${token}` });

    // Waits for the fan-out of one event to the test endpoint and returns the
    // delivered payload.
    const delivered = async (eventType: string, entityId: string) => {
      const where = {
        webhookEndpointId: endpointId,
        eventType,
        payload: { path: ["entityId"], equals: entityId },
      };
      await waitFor(
        async () => (await prisma.webhookDelivery.count({ where })) > 0,
        10_000
      );
      const deliveries = await prisma.webhookDelivery.findMany({ where });
      return deliveries.map((d) => d.payload as Record<string, unknown>);
    };

    const enableVersioning = (bucketName: string) =>
      axios.put(
        `${BASE_URL}/buckets/${bucketName}`,
        { versioningEnabled: true },
        { headers: auth() }
      );

    beforeAll(async () => {
      token = await getTestPrincipalToken({
        organizationId: ORG_ID,
        permissions: ["file-service.admin"],
      });
      const endpoint = await createTestWebhookEndpoint(
        await getCoreEventSubscriberToken(ORG_ID),
        { eventTypes: EVENT_TYPES }
      );
      endpointId = endpoint.id;
    });

    afterAll(async () => {
      await cleanupTestEntities();
      await cleanupWebhookEntities();
    });

    it("emits object.updated when a version restore undeletes the object", async () => {
      const bucket = await createTestBucket(token);
      await enableVersioning(bucket.name);
      const obj = await uploadTestObject(
        token,
        bucket.name,
        "undeleted.txt",
        createTestFile(`restore-${randomUUID()}`, "undeleted.txt")
      );
      const original = await prisma.objectVersion.findFirstOrThrow({
        where: { objectId: obj.id, isCurrent: true },
      });
      const del = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}`,
        { headers: auth() }
      );
      expect(del.status).toBe(HTTP_STATUS.NO_CONTENT);
      const restore = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}/versions/${original.id}/restore`,
        {},
        { headers: auth() }
      );
      expect(restore.status).toBe(HTTP_STATUS.CREATED);

      const [payload] = await delivered("file-service.object.updated", obj.id);
      expect(payload).toMatchObject({
        entityType: "object",
        data: {
          bucketName: bucket.name,
          objectKey: "undeleted.txt",
          objectId: obj.id,
          etag: original.etag,
          via: "restore",
          restoredFromVersionId: original.id,
        },
      });
    });

    it("emits object.updated when a version restore replaces a live object's content", async () => {
      const bucket = await createTestBucket(token);
      await enableVersioning(bucket.name);
      const obj = await uploadTestObject(
        token,
        bucket.name,
        "restored.txt",
        createTestFile(`first-${randomUUID()}`, "restored.txt")
      );
      const first = await prisma.objectVersion.findFirstOrThrow({
        where: { objectId: obj.id, isCurrent: true },
      });
      await uploadTestObject(
        token,
        bucket.name,
        "restored.txt",
        createTestFile(`second-${randomUUID()}`, "restored.txt")
      );
      const restore = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}/versions/${first.id}/restore`,
        {},
        { headers: auth() }
      );
      expect(restore.status).toBe(HTTP_STATUS.CREATED);

      await waitFor(
        async () =>
          (await delivered("file-service.object.updated", obj.id)).some(
            (p) => (p.data as { via: string }).via === "restore"
          ),
        10_000
      );
      const restored = (await delivered("file-service.object.updated", obj.id))
        .map((p) => p.data as Record<string, unknown>)
        .find((d) => d.via === "restore");
      expect(restored).toMatchObject({
        etag: first.etag,
        restoredFromVersionId: first.id,
        undeleted: false,
      });
    });
  });
});
