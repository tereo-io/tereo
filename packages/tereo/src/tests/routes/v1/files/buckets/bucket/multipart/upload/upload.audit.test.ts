// @module-tag int
// @module-tag files
import { processMultipartSweepTick } from "../../../../../../../../jobs/multipartSweep.js";
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "crypto";
import axios from "axios";
import {
  FIXTURE_ORGANIZATION_IDS,
  getTestPrincipalToken,
} from "../../../../../../../support/principals.js";
import {
  cleanupTestEntities as cleanupWebhookEntities,
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
} from "../../../../../../../support/webhooks.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  deliveredPayloads,
} from "../../../../../../../support/files.js";

describe("POST and DELETE /v1/files/buckets/:name/multipart/:uploadId", () => {
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
  const delivered = (eventType: string, entityId: string) =>
    deliveredPayloads(endpointId, eventType, entityId);

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

  it("audits the object a complete writes, as an upload does", async () => {
    const bucket = await createTestBucket(token);
    const uploadId = await startMultipart(bucket.name, "audited.bin");
    const put = await axios.put(
      `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}/parts/1`,
      Buffer.from(`part ${randomUUID()}`),
      { headers: { ...auth(), "Content-Type": "application/octet-stream" } }
    );
    expect(put.status).toBe(HTTP_STATUS.OK);
    const created = await axios.post(
      `${BASE_URL}/buckets/${bucket.name}/multipart/${uploadId}/complete`,
      { parts: [{ partNumber: 1, etag: put.data.etag }] },
      { headers: { ...auth(), "Idempotency-Key": randomUUID() } }
    );
    expect(created.status).toBe(HTTP_STATUS.CREATED);
    const entry = await prisma.auditLogEntry.findFirst({
      where: { entityType: "object", entityId: created.data.id },
    });
    expect(entry).toMatchObject({
      action: "CREATE",
      entityName: created.data.key,
    });
    expect(entry?.metadata).toMatchObject({ multipartUploadId: uploadId });
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
    const uploadAudits = await prisma.auditLogEntry.findMany({
      where: { entityType: "multipartUpload", entityId: uploadId },
      orderBy: { createdAt: "asc" },
    });
    expect(uploadAudits.map((e) => e.action)).toEqual(["CREATE", "UPDATE"]);
    expect(uploadAudits[1].metadata).toMatchObject({ completed: true });

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
