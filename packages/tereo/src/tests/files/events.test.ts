import { processMultipartSweepTick } from "../../jobs/multipartSweep.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { createHash, randomUUID } from "crypto";
import axios from "axios";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  cleanupTestEntities as cleanupWebhookEntities,
  waitFor,
} from "../webhooks/utils/test-helpers.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  grantTestPermission,
  uploadTestObject,
} from "./utils/test-helpers.js";
import {
  FIXTURE_ORGANIZATION_IDS,
  ensureTestMembership,
  getTestPrincipalToken,
} from "../utils/principals.js";

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

describe("file-service webhook events", () => {
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

  const startMultipart = async (bucketName: string, objectKey: string) => {
    const response = await axios.post(
      `${BASE_URL}/buckets/${bucketName}/multipart`,
      { objectKey, contentType: "application/octet-stream" },
      { headers: auth() }
    );
    expect(response.status).toBe(HTTP_STATUS.CREATED);
    return response.data.uploadId as string;
  };

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

  it("emits bucket.created", async () => {
    const bucket = await createTestBucket(token);

    const [payload] = await delivered(
      "file-service.bucket.created",
      String(bucket.id)
    );
    expect(payload).toMatchObject({
      organizationId: ORG_ID,
      entityType: "bucket",
      data: {
        bucketName: bucket.name,
        policy: "private",
        versioningEnabled: false,
      },
    });
  });

  it("emits bucket.updated only when an update changes something", async () => {
    const bucket = await createTestBucket(token);
    const put = (body: Record<string, unknown>) =>
      axios.put(`${BASE_URL}/buckets/${bucket.name}`, body, {
        headers: auth(),
      });

    // Unchanged: no audit entry, and no event.
    await put({ versioningEnabled: false, policy: "private" });
    await put({ description: "changed" });

    const [payload] = await delivered(
      "file-service.bucket.updated",
      String(bucket.id)
    );
    expect(payload).toMatchObject({ data: { bucketName: bucket.name } });
    const outboxed = await prisma.webhookDelivery.count({
      where: {
        webhookEndpointId: endpointId,
        eventType: "file-service.bucket.updated",
        payload: { path: ["entityId"], equals: String(bucket.id) },
      },
    });
    expect(outboxed).toBe(1);
    expect(
      await prisma.auditLogEntry.count({
        where: {
          entityType: "bucket",
          entityId: String(bucket.id),
          action: "UPDATE",
        },
      })
    ).toBe(1);
  });

  it("emits lifecycle.policy.updated with the stored policy", async () => {
    const bucket = await createTestBucket(token);
    const response = await axios.put(
      `${BASE_URL}/buckets/${bucket.name}/lifecycle`,
      { expireObjectsAfterDays: 30, enabled: false },
      { headers: auth() }
    );
    expect(response.status).toBe(HTTP_STATUS.OK);

    const [payload] = await delivered(
      "file-service.lifecycle.policy.updated",
      String(bucket.id)
    );
    expect(payload).toMatchObject({
      organizationId: ORG_ID,
      entityType: "bucket",
      data: {
        bucketId: bucket.id,
        bucketName: bucket.name,
        expireObjectsAfterDays: 30,
        expireVersionsAfterDays: null,
        purgeSoftDeletedAfterDays: null,
        enabled: false,
      },
    });
  });

  it("emits lifecycle.policy.deleted only when a policy was removed", async () => {
    const bucket = await createTestBucket(token);
    const url = `${BASE_URL}/buckets/${bucket.name}/lifecycle`;

    // No policy yet: still 204, but nothing to announce.
    expect((await axios.delete(url, { headers: auth() })).status).toBe(
      HTTP_STATUS.NO_CONTENT
    );
    await axios.put(url, { expireVersionsAfterDays: 7 }, { headers: auth() });
    expect((await axios.delete(url, { headers: auth() })).status).toBe(
      HTTP_STATUS.NO_CONTENT
    );

    const payloads = await delivered(
      "file-service.lifecycle.policy.deleted",
      String(bucket.id)
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      organizationId: ORG_ID,
      entityType: "bucket",
      data: { bucketId: bucket.id, bucketName: bucket.name },
    });
  });

  it("emits permission.granted for the creator's grant on bucket.create", async () => {
    const bucket = await createTestBucket(token);
    const grant = await prisma.bucketPermission.findFirstOrThrow({
      where: { bucketId: bucket.id, userId: bucket.createdBy },
    });

    const [payload] = await delivered(
      "file-service.permission.granted",
      String(grant.id)
    );
    expect(payload).toMatchObject({
      organizationId: ORG_ID,
      entityType: "bucketPermission",
      data: {
        bucketName: bucket.name,
        userId: bucket.createdBy,
        canRead: true,
        canWrite: true,
        canDelete: true,
        grantedBy: bucket.createdBy,
      },
    });
  });

  it("emits bucket.owner-changed on a transfer", async () => {
    const bucket = await createTestBucket(token);
    const next = randomUUID();
    await ensureTestMembership(next, ORG_ID);

    const res = await axios.put(
      `${BASE_URL}/buckets/${bucket.name}/owner`,
      { userId: next },
      { headers: auth() }
    );
    expect(res.status).toBe(HTTP_STATUS.OK);

    const [payload] = await delivered(
      "file-service.bucket.owner-changed",
      String(bucket.id)
    );
    expect(payload).toMatchObject({
      organizationId: ORG_ID,
      entityType: "bucket",
      data: {
        bucketName: bucket.name,
        ownerId: next,
        previousOwnerId: bucket.createdBy,
      },
    });
  });

  it("emits object.version.created for each write to a versioned bucket", async () => {
    const bucket = await createTestBucket(token);
    await enableVersioning(bucket.name);

    const first = await uploadTestObject(
      token,
      bucket.name,
      "doc.txt",
      createTestFile("v1")
    );
    await uploadTestObject(token, bucket.name, "doc.txt", createTestFile("v2"));

    const versions = await prisma.objectVersion.findMany({
      where: { objectId: first.id },
      orderBy: { createdAt: "asc" },
    });
    expect(versions).toHaveLength(2);

    for (const version of versions) {
      const [payload] = await delivered(
        "file-service.object.version.created",
        version.id
      );
      expect(payload).toMatchObject({
        entityType: "objectVersion",
        data: {
          bucketName: bucket.name,
          objectKey: "doc.txt",
          objectId: first.id,
          versionId: version.id,
          etag: version.etag,
          sizeBytes: "2",
          via: "direct",
        },
      });
    }
  });

  it("emits object.version.created when PATCH branches a new version", async () => {
    const bucket = await createTestBucket(token);
    await enableVersioning(bucket.name);
    const uploaded = await uploadTestObject(
      token,
      bucket.name,
      "meta.txt",
      createTestFile("meta")
    );

    const patch = await axios.patch(
      `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${uploaded.id}`,
      { metadata: { reviewed: "yes" }, createNewVersion: true },
      { headers: auth() }
    );
    expect(patch.status).toBe(HTTP_STATUS.OK);

    const current = await prisma.objectVersion.findFirstOrThrow({
      where: { objectId: uploaded.id, isCurrent: true },
    });
    const [payload] = await delivered(
      "file-service.object.version.created",
      current.id
    );
    expect(payload).toMatchObject({
      data: { objectId: uploaded.id, versionId: current.id, via: "metadata" },
    });
  });

  it("does not emit object.version.created in an unversioned bucket", async () => {
    const bucket = await createTestBucket(token);
    const uploaded = await uploadTestObject(
      token,
      bucket.name,
      "plain.txt",
      createTestFile("plain")
    );
    await delivered("file-service.object.created", uploaded.id);
    // Events from one transaction fan out in parallel; give a stray one time to land.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const version = await prisma.objectVersion.findFirstOrThrow({
      where: { objectId: uploaded.id },
    });
    const count = await prisma.webhookDelivery.count({
      where: {
        webhookEndpointId: endpointId,
        eventType: "file-service.object.version.created",
        payload: { path: ["entityId"], equals: version.id },
      },
    });
    expect(count).toBe(0);
  });

  it("emits permission.granted and permission.revoked", async () => {
    const bucket = await createTestBucket(token);
    const userId = randomUUID();
    await ensureTestMembership(userId, ORG_ID);

    const grant = await grantTestPermission(token, bucket.name, userId, {
      canRead: true,
      canWrite: true,
    });
    const [granted] = await delivered(
      "file-service.permission.granted",
      String(grant.id)
    );
    expect(granted).toMatchObject({
      entityType: "bucketPermission",
      data: {
        bucketName: bucket.name,
        userId,
        canRead: true,
        canWrite: true,
        canDelete: false,
      },
    });

    const revoke = await axios.delete(
      `${BASE_URL}/buckets/${bucket.name}/permissions/${userId}`,
      { headers: auth() }
    );
    expect(revoke.status).toBe(HTTP_STATUS.NO_CONTENT);
    const [revoked] = await delivered(
      "file-service.permission.revoked",
      String(grant.id)
    );
    expect(revoked).toMatchObject({
      data: { bucketName: bucket.name, userId },
    });

    const again = await axios.delete(
      `${BASE_URL}/buckets/${bucket.name}/permissions/${userId}`,
      { headers: auth(), validateStatus: () => true }
    );
    expect(again.status).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it("emits object.created and version.created when a multipart upload completes", async () => {
    const bucket = await createTestBucket(token);
    await enableVersioning(bucket.name);
    const uploadId = await startMultipart(bucket.name, "big.bin");

    const body = Buffer.from(`multipart-${randomUUID()}`);
    const part = await axios.put(
      `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}/parts/1`,
      body,
      { headers: { ...auth(), "Content-Type": "application/octet-stream" } }
    );
    expect(part.status).toBe(HTTP_STATUS.OK);
    expect(part.data.etag).toBe(createHash("md5").update(body).digest("hex"));

    const complete = await axios.post(
      `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}/complete`,
      { parts: [{ partNumber: 1, etag: part.data.etag }] },
      { headers: { ...auth(), "Idempotency-Key": randomUUID() } }
    );
    expect(complete.status).toBe(HTTP_STATUS.CREATED);
    const objectId = complete.data.id as string;

    const [completed] = await delivered(
      "file-service.multipart.completed",
      uploadId
    );
    expect(completed).toMatchObject({ data: { objectId } });

    const [created] = await delivered("file-service.object.created", objectId);
    expect(created).toMatchObject({
      entityType: "object",
      data: {
        bucketName: bucket.name,
        objectKey: "big.bin",
        sizeBytes: String(body.length),
        etag: complete.data.etag,
        via: "multipart",
      },
    });

    const version = await prisma.objectVersion.findFirstOrThrow({
      where: { objectId, isCurrent: true },
    });
    const [versionCreated] = await delivered(
      "file-service.object.version.created",
      version.id
    );
    expect(versionCreated).toMatchObject({
      data: { objectId, via: "multipart" },
    });
  });

  it("emits multipart.aborted with a reason for explicit aborts and expiry", async () => {
    const bucket = await createTestBucket(token);

    const abortedId = await startMultipart(bucket.name, "aborted.bin");
    const abort = await axios.delete(
      `${BASE_URL}/buckets/${bucket.name}/multipart/${abortedId}`,
      { headers: auth() }
    );
    expect(abort.status).toBe(HTTP_STATUS.NO_CONTENT);
    const [aborted] = await delivered(
      "file-service.multipart.aborted",
      abortedId
    );
    expect(aborted).toMatchObject({
      data: {
        bucketName: bucket.name,
        objectKey: "aborted.bin",
        reason: "aborted",
      },
    });

    const expiredId = await startMultipart(bucket.name, "expired.bin");
    await prisma.multipartUpload.update({
      where: { id: expiredId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await processMultipartSweepTick();

    const [expired] = await delivered(
      "file-service.multipart.aborted",
      expiredId
    );
    expect(expired).toMatchObject({
      entityType: "multipartUpload",
      data: {
        bucketName: bucket.name,
        objectKey: "expired.bin",
        reason: "expired",
      },
    });
    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        entityId: expiredId,
        entityType: "multipartUpload",
        action: "DELETE",
      },
    });
    expect(entry).toMatchObject({
      action: "DELETE",
      metadata: expect.objectContaining({ reason: "expired" }),
    });

    // A second sweep finds nothing to abort, so the event is not repeated.
    await processMultipartSweepTick();
    expect(
      await delivered("file-service.multipart.aborted", expiredId)
    ).toHaveLength(1);
  });
});
