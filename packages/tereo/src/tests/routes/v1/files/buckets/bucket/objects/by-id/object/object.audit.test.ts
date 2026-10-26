// @module-tag int
// @module-tag files
import { prisma } from "../../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  FIXTURE_ORGANIZATION_IDS,
  getTestPrincipalToken,
} from "../../../../../../../../support/principals.js";
import {
  cleanupTestEntities as cleanupWebhookEntities,
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
} from "../../../../../../../../support/webhooks.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  uploadTestObject,
  deliveredPayloads,
} from "../../../../../../../../support/files.js";

describe("PATCH /v1/files/buckets/:name/objects/by-id/:id", () => {
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

  it("writes no audit entry and emits nothing for a PATCH that changes nothing", async () => {
    const bucket = await createTestBucket(token);
    const obj = await uploadTestObject(
      token,
      bucket.name,
      "unchanged.txt",
      createTestFile(`patch-${randomUUID()}`, "unchanged.txt")
    );
    const patch = (body: Record<string, unknown>) =>
      axios.patch(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}`,
        body,
        { headers: auth() }
      );

    const same = await patch({
      objectKey: "unchanged.txt",
      contentType: obj.contentType,
      tags: obj.tags,
      deleteAfter: null,
    });
    expect(same.status).toBe(HTTP_STATUS.OK);
    expect(same.data).toMatchObject({ id: obj.id, key: "unchanged.txt" });
    const audits = () =>
      prisma.auditLogEntry.count({
        where: { entityType: "object", entityId: obj.id, action: "UPDATE" },
      });
    expect(await audits()).toBe(0);

    expect((await patch({ tags: ["changed"] })).status).toBe(HTTP_STATUS.OK);
    expect(await audits()).toBe(1);
    const updates = await delivered("file-service.object.updated", obj.id);
    expect(updates).toHaveLength(1);
  });
});
