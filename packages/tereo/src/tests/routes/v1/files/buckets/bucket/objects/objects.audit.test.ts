// @module-tag int
// @module-tag files
// @module-tag slow
import { resetRateLimits } from "../../../../../../support/redis.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  FIXTURE_ORGANIZATION_IDS,
  getTestPrincipalToken,
} from "../../../../../../support/principals.js";
import {
  cleanupTestEntities as cleanupWebhookEntities,
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../../../../../support/webhooks.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObject,
} from "../../../../../../support/files.js";

describe("POST /v1/files/buckets/:name/objects/bulk-delete", () => {
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

  const keys = async (bucketName: string) => {
    const res = await axios.get(
      `${BASE_URL}/buckets/${bucketName}/objects`,
      auth()
    );
    return res.data.data.map((o: { key: string }) => o.key).sort();
  };

  it("deletes by prefix and by id, with one audit entry each", async () => {
    const bucket = await createTestBucket(token);
    for (const key of ["a/1.txt", "a/2.txt", "a/b/3.txt"]) {
      await uploadTestObject(
        token,
        bucket.name,
        key,
        createTestFile(`${key} ${randomUUID()}`)
      );
    }
    const keep = await uploadTestObject(
      token,
      bucket.name,
      "b/keep.txt",
      createTestFile(`keep ${randomUUID()}`)
    );
    const url = `${BASE_URL}/buckets/${bucket.name}/objects/bulk-delete`;

    const byPrefix = await axios.post(url, { prefix: "a/" }, auth());
    expect(byPrefix.status).toBe(HTTP_STATUS.OK);
    expect(byPrefix.data).toEqual({ deletedCount: 3, truncated: false });
    expect(await keys(bucket.name)).toEqual(["b/keep.txt"]);

    const byId = await axios.post(url, { ids: [keep.id] }, auth());
    expect(byId.data).toEqual({ deletedCount: 1, truncated: false });
    expect(await keys(bucket.name)).toEqual([]);

    const entries = await prisma.auditLogEntry.findMany({
      where: { entityType: "objects_bulk", entityId: String(bucket.id) },
    });
    expect(entries).toHaveLength(2);
  });

  it("emits an event per committed batch, in the batch's transaction", async () => {
    const orgId = FIXTURE_ORGANIZATION_IDS[1];
    const orgToken = await getTestPrincipalToken({
      organizationId: orgId,
      permissions: ["file-service.admin"],
    });
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(orgId),
      { eventTypes: ["file-service.objects.bulk-deleted"] }
    );
    try {
      const bucket = await createTestBucket(orgToken);
      const keys = Array.from({ length: 101 }, (_, i) => `batch/${i}.txt`);
      for (let i = 0; i < keys.length; i += 10) {
        await Promise.all(
          keys
            .slice(i, i + 10)
            .map((key) =>
              uploadTestObject(
                orgToken,
                bucket.name,
                key,
                createTestFile(`${key} ${randomUUID()}`)
              )
            )
        );
        // The general limiter allows 100 requests a second per user, more
        // than these uploads take together: start it over between chunks.
        await resetRateLimits();
      }

      const res = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/objects/bulk-delete`,
        { prefix: "batch/" },
        { headers: { Authorization: `Bearer ${orgToken}` } }
      );
      expect(res.data).toEqual({ deletedCount: 101, truncated: false });

      const where = {
        webhookEndpointId: endpoint.id,
        eventType: "file-service.objects.bulk-deleted",
        payload: { path: ["entityId"], equals: String(bucket.id) },
      };
      await waitFor(
        async () => (await prisma.webhookDelivery.count({ where })) === 2,
        30_000
      );
      const events = (await prisma.webhookDelivery.findMany({ where }))
        .map((d) => (d.payload as { data: Record<string, unknown> }).data)
        .sort((a, b) => Number(a.batchIndex) - Number(b.batchIndex));
      expect(events).toMatchObject([
        { batchIndex: 0, deletedCount: 100 },
        { batchIndex: 1, deletedCount: 1 },
      ]);
      expect((events[0].objects as unknown[]).length).toBe(100);
      expect(events[0]).not.toHaveProperty("truncated");
    } finally {
      await cleanupWebhookEntities();
    }
  });
});
