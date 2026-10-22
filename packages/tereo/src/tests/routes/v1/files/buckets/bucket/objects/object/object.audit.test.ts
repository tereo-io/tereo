// @module-tag int
// @module-tag files
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import axios from "axios";
import {
  FIXTURE_ORGANIZATION_IDS,
  getTestPrincipalToken,
} from "../../../../../../../support/principals.js";
import {
  cleanupTestEntities as cleanupWebhookEntities,
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../../../../support/webhooks.js";
import {
  BASE_URL,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  uploadTestObject,
} from "../../../../../../../support/files.js";

describe("PUT /v1/files/buckets/:name/objects/*objectKey", () => {
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
});
