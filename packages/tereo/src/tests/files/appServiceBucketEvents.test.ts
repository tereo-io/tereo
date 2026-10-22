import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  createAppServiceAccount,
  TEST_SERVICE_ID,
} from "../support/testService.js";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../support/principals.js";
import {
  BASE_URL,
  getTestAccessToken,
  removeBuckets,
  uploadTestObject,
  uploadTestObjectAndGetId,
  waitFor,
} from "../support/files.js";

// A bucket an app service declares belongs to no organization. Its events
// are emitted without one and go only to endpoints of all organizations and
// to the service's own endpoints.

const EVENT = "file-service.object.created";
const SHARE_EVENT = "file-service.share.created";

describe("events of a bucket outside any organization", () => {
  const bucketName = `test-bucket-app-${randomUUID().slice(0, 8)}`;
  let bucketId: number;
  const endpointIds: Record<string, string> = {};

  const endpoint = async (
    label: string,
    data: {
      organizationId: string | null;
      ownerServiceId: string | null;
      createdBy: string;
    }
  ) => {
    const { endpoint } = await db.webhookEndpoints.create({
      ...data,
      url: `https://example.com/app-bucket/${label}`,
      eventTypes: [EVENT, SHARE_EVENT],
    });
    endpointIds[label] = endpoint.id;
  };

  const deliveriesTo = (label: string, objectKey: string) =>
    prisma.webhookDelivery.findMany({
      where: {
        webhookEndpointId: endpointIds[label],
        payload: { path: ["data", "objectKey"], equals: objectKey },
      },
    });

  beforeAll(async () => {
    const account = await createAppServiceAccount("app-bucket-events");
    const service = await prisma.service.findUniqueOrThrow({
      where: { slug: account.slug },
    });
    // The service's account reads objects; its grant on the bucket is below.
    await getTestPrincipalToken({
      userId: account.userId,
      organizationId: null,
      permissions: ["file-service.objects.read"],
    });
    const bucket = await prisma.bucket.create({
      data: {
        name: bucketName,
        serviceId: service.id,
        createdBy: account.userId,
        ownerId: account.userId,
      },
    });
    bucketId = bucket.id;
    await prisma.bucketPermission.create({
      data: {
        bucketId,
        userId: account.userId,
        canRead: true,
        canWrite: true,
        canDelete: true,
        grantedBy: SYSTEM_USER_ID,
      },
    });

    const org = await ensureTestOrganization("app-bucket-events");
    await endpoint("allOrganizations", {
      organizationId: null,
      ownerServiceId: TEST_SERVICE_ID,
      createdBy: SYSTEM_USER_ID,
    });
    await endpoint("bucketService", {
      organizationId: org,
      ownerServiceId: service.id,
      createdBy: account.userId,
    });
    await endpoint("otherService", {
      organizationId: org,
      ownerServiceId: TEST_SERVICE_ID,
      createdBy: SYSTEM_USER_ID,
    });
    await endpoint("organization", {
      organizationId: org,
      ownerServiceId: null,
      createdBy: SYSTEM_USER_ID,
    });
  });

  afterAll(async () => {
    const ids = Object.values(endpointIds);
    await prisma.webhookDelivery.deleteMany({
      where: { webhookEndpointId: { in: ids } },
    });
    await prisma.webhookEndpoint.deleteMany({ where: { id: { in: ids } } });
    await removeBuckets([bucketId]);
  });

  it("go to endpoints of all organizations and the bucket's service only", async () => {
    const objectKey = `${randomUUID()}.txt`;
    await uploadTestObject(await getTestAccessToken(), bucketName, objectKey, {
      buffer: Buffer.from("app bucket"),
      filename: objectKey,
      contentType: "text/plain",
    });

    await waitFor(
      async () =>
        (await deliveriesTo("allOrganizations", objectKey)).length > 0 &&
        (await deliveriesTo("bucketService", objectKey)).length > 0,
      10_000
    );
    const [delivery] = await deliveriesTo("allOrganizations", objectKey);
    expect(delivery.payload).toMatchObject({
      organizationId: null,
      eventType: EVENT,
      data: { bucketName, objectKey },
    });
    expect(await deliveriesTo("otherService", objectKey)).toHaveLength(0);
    expect(await deliveriesTo("organization", objectKey)).toHaveLength(0);
  });

  it("include share events", async () => {
    const token = await getTestAccessToken();
    const objectKey = `${randomUUID()}.txt`;
    const objectId = await uploadTestObjectAndGetId(
      token,
      bucketName,
      objectKey,
      {
        buffer: Buffer.from("app bucket share"),
        filename: objectKey,
        contentType: "text/plain",
      }
    );
    const created = await axios.post(
      `${BASE_URL}/buckets/${bucketName}/shares`,
      { kind: "OBJECT", objectId },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const shareId = created.data.id as string;
    const shareDeliveries = (label: string) =>
      prisma.webhookDelivery.findMany({
        where: {
          webhookEndpointId: endpointIds[label],
          eventType: SHARE_EVENT,
          payload: { path: ["entityId"], equals: shareId },
        },
      });

    await waitFor(
      async () => (await shareDeliveries("allOrganizations")).length > 0,
      10_000
    );
    const [delivery] = await shareDeliveries("allOrganizations");
    expect(delivery.payload).toMatchObject({
      organizationId: null,
      data: { bucketName, objectId },
    });
    expect(await shareDeliveries("organization")).toHaveLength(0);
  });
});
