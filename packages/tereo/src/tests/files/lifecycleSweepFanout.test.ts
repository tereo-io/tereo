import * as webhookHelpers from "../webhooks/utils/test-helpers.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import type { Job } from "bullmq";
import { Client } from "pg";
import {
  processLifecycleSweepOrchestrator,
  processLifecycleSweepPerObjectTtl,
  processLifecycleSweepPolicy,
} from "../../jobs/lifecycleSweep.js";
import {
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObject,
} from "./utils/test-helpers.js";
import {
  getLifecyclePolicyQueue,
  getLifecycleOrchestratorQueue,
  getLifecyclePerObjectTtlQueue,
} from "../../jobs/queues.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * Build a minimal `Job` stand-in. We only need `data`, `id`, and
 * `updateProgress` — everything else the job processor touches is
 * queue-level, not job-level.
 */
function fakeJob<T>(data: T, id = "fake-1"): Job<T> {
  return {
    id,
    data,
    updateProgress: async () => undefined,
  } as unknown as Job<T>;
}

describe("lifecycle sweep fan-out", () => {
  let token: string;

  beforeAll(async () => {
    token = await getTestAccessToken();
    // Pause the fan-out queues so the running workers (started in
    // globalSetup) don't pick up jobs that the orchestrator enqueues mid-test.
    // Without this, the worker would race the afterEach `obliterate` and emit
    // "Missing key for job ... moveToFinished/moveToDelayed" warnings when
    // the job hash gets wiped before the worker bookkeeps completion.
    // Tests that need to exercise a processor call it directly with a fake
    // job, so paused queues don't affect them.
    await getLifecyclePolicyQueue().pause();
    await getLifecyclePerObjectTtlQueue().pause();
  });

  afterAll(async () => {
    await Promise.allSettled([
      getLifecyclePolicyQueue().resume(),
      getLifecyclePerObjectTtlQueue().resume(),
      cleanupTestEntities(),
    ]);
  });

  afterEach(async () => {
    // Clear any jobs the orchestrator enqueued onto the real fan-out queues
    // so subsequent test runs start from a clean slate. Queues are paused
    // (see beforeAll), so jobs sit in `paused` and never went `active`.
    await getLifecyclePolicyQueue().obliterate({ force: true });
    await getLifecyclePerObjectTtlQueue().obliterate({ force: true });
    await getLifecycleOrchestratorQueue().obliterate({ force: true });
  });

  it("orchestrator enqueues one policy job per enabled policy", async () => {
    const bucketA = await createTestBucket(token, { policy: "private" });
    const bucketB = await createTestBucket(token, { policy: "private" });
    // Enable policies on both.
    await db.lifecyclePolicies.upsert({
      bucketId: bucketA.id,
      expireObjectsAfterDays: 1,
      enabled: true,
    });
    await db.lifecyclePolicies.upsert({
      bucketId: bucketB.id,
      expireObjectsAfterDays: 1,
      enabled: true,
    });

    await processLifecycleSweepOrchestrator();

    const policyQueue = getLifecyclePolicyQueue();
    const jobs = await policyQueue.getJobs(
      ["wait", "delayed", "active", "paused"],
      0,
      -1
    );
    const enqueuedBucketIds = jobs.map(
      (j) => (j.data as { bucketId: number }).bucketId
    );
    // Both test buckets should be represented. Other enabled policies from
    // prior tests may also be present — so assert inclusion, not exact equality.
    expect(enqueuedBucketIds).toContain(bucketA.id);
    expect(enqueuedBucketIds).toContain(bucketB.id);

    // Per-object TTL job should also have been enqueued. The TTL queue is
    // paused for this test file (see beforeAll), so the job sits in `paused`
    // and we assert against that state rather than racing the worker.
    const ttlJobs = await getLifecyclePerObjectTtlQueue().getJobs(
      ["wait", "delayed", "active", "paused", "completed"],
      0,
      -1
    );
    expect(ttlJobs.length).toBeGreaterThanOrEqual(1);
  });

  it("per-policy worker processes a batch and completes when empty", async () => {
    const bucket = await createTestBucket(token, { policy: "private" });
    // Upload an object and age its last write so expireObjects picks it up.
    const key = `expire-${Date.now()}.txt`;
    const uploaded = await uploadTestObject(
      token,
      bucket.name,
      key,
      createTestFile("hi", key, "text/plain")
    );
    await prisma.objectVersion.updateMany({
      where: { objectId: uploaded.id },
      data: { createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) },
    });
    await db.lifecyclePolicies.upsert({
      bucketId: bucket.id,
      expireObjectsAfterDays: 1,
      enabled: true,
    });

    await processLifecycleSweepPolicy(
      fakeJob({ bucketId: bucket.id, continuation: 0 })
    );

    const after = await prisma.object.findFirst({
      where: { bucketId: bucket.id, objectKey: key },
    });
    expect(after?.deletedAt).not.toBeNull();
  });

  it("counts an object's age from its last write and audits what it expires", async () => {
    const bucket = await createTestBucket(token, { policy: "private" });
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const upload = (key: string, body: string) =>
      uploadTestObject(token, bucket.name, key, createTestFile(body, key));
    const stale = await upload("stale.txt", "stale");
    const rewritten = await upload("rewritten.txt", "first");
    // Both keys are old; only `stale.txt` hasn't been written since.
    await prisma.object.updateMany({
      where: { id: { in: [stale.id, rewritten.id] } },
      data: { createdAt: tenDaysAgo },
    });
    await prisma.objectVersion.updateMany({
      where: { objectId: { in: [stale.id, rewritten.id] } },
      data: { createdAt: tenDaysAgo },
    });
    await upload("rewritten.txt", "second");
    await db.lifecyclePolicies.upsert({
      bucketId: bucket.id,
      expireObjectsAfterDays: 1,
      enabled: true,
    });

    await processLifecycleSweepPolicy(
      fakeJob({ bucketId: bucket.id, continuation: 0 })
    );

    const rows = await prisma.object.findMany({
      where: { bucketId: bucket.id },
      orderBy: { objectKey: "asc" },
    });
    expect(rows.map((o) => [o.objectKey, o.deletedAt !== null])).toEqual([
      ["rewritten.txt", false],
      ["stale.txt", true],
    ]);
    const audit = await prisma.auditLogEntry.findMany({
      where: { entityType: "lifecycleSweep", entityId: String(bucket.id) },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({
      stage: "expireObjects",
      processed: 1,
      entities: [{ id: stale.id, objectKey: "stale.txt" }],
    });
  });

  it("per-policy worker exits cleanly on a bucket with no enabled policy", async () => {
    const bucket = await createTestBucket(token, { policy: "private" });
    // No policy at all for this bucket — worker should return without error.
    await expect(
      processLifecycleSweepPolicy(
        fakeJob({ bucketId: bucket.id, continuation: 0 })
      )
    ).resolves.toBeUndefined();
  });

  it("per-object TTL worker soft-deletes rows whose deleteAfter is in the past", async () => {
    const bucket = await createTestBucket(token, { policy: "private" });
    const key = `ttl-${Date.now()}.txt`;
    await uploadTestObject(
      token,
      bucket.name,
      key,
      createTestFile("hello", key, "text/plain")
    );
    await prisma.object.updateMany({
      where: { bucketId: bucket.id, objectKey: key, deletedAt: null },
      data: { deleteAfter: new Date(Date.now() - 60_000) },
    });

    await processLifecycleSweepPerObjectTtl(fakeJob({ continuation: 0 }));

    const after = await prisma.object.findFirst({
      where: { bucketId: bucket.id, objectKey: key },
    });
    expect(after?.deletedAt).not.toBeNull();
    const audit = await prisma.auditLogEntry.findFirst({
      where: { entityType: "lifecycleSweep", entityId: String(bucket.id) },
    });
    expect(audit?.metadata).toMatchObject({ stage: "perObjectTtl" });
  });
});

describe("batch deletes and their audit entries commit together", () => {
  let token: string;
  const fail = async () => {
    throw new Error("audit write failed");
  };

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  const live = (bucketId: number) =>
    prisma.object.count({ where: { bucketId, deletedAt: null } });

  it("a lifecycle batch is undone when its audit entry fails", async () => {
    const bucket = await createTestBucket(token);
    const obj = await uploadTestObject(
      token,
      bucket.name,
      "e.txt",
      createTestFile("e")
    );
    await expect(
      db.objects.removeExpiredObjects(
        bucket.id,
        [obj.id],
        { lastWrittenBefore: new Date(Date.now() + 60_000) },
        SYSTEM_USER_ID,
        fail
      )
    ).rejects.toThrow("audit write failed");
    expect(await live(bucket.id)).toBe(1);
  });

  it("batch deletes don't skip a row held only by a foreign-key check", async () => {
    const bucket = await createTestBucket(token);
    const a = await uploadTestObject(
      token,
      bucket.name,
      "k/a.txt",
      createTestFile("a")
    );
    const b = await uploadTestObject(
      token,
      bucket.name,
      "k/b.txt",
      createTestFile("b")
    );
    // The lock an insert referencing the object takes, as the access log
    // written after each request does.
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        `SELECT 1 FROM "files"."objects" WHERE "id" = ANY($1::uuid[]) FOR KEY SHARE`,
        [[a.id, b.id]]
      );
      const expired = await db.objects.removeExpiredObjects(
        bucket.id,
        [a.id],
        { lastWrittenBefore: new Date(Date.now() + 60_000) },
        SYSTEM_USER_ID
      );
      const bulk = await db.objects.removeObjectsBulk(
        bucket.id,
        { kind: "prefix", prefix: "k/" },
        SYSTEM_USER_ID
      );
      expect(expired.map((o) => o.id)).toEqual([a.id]);
      expect(bulk.deletedObjects.map((o) => o.id)).toEqual([b.id]);
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
  });

  it("a bulk delete batch is undone when its audit entry fails", async () => {
    const bucket = await createTestBucket(token);
    await uploadTestObject(token, bucket.name, "a/1.txt", createTestFile("1"));
    await expect(
      db.objects.removeObjectsBulk(
        bucket.id,
        { kind: "prefix", prefix: "a/" },
        SYSTEM_USER_ID,
        { onBatch: fail }
      )
    ).rejects.toThrow("audit write failed");
    expect(await live(bucket.id)).toBe(1);
  });

  it("a history purge batch is undone when its audit entry fails", async () => {
    const bucket = await createTestBucket(token);
    await prisma.bucket.update({
      where: { id: bucket.id },
      data: { versioningEnabled: true },
    });
    const obj = await uploadTestObject(
      token,
      bucket.name,
      "h.txt",
      createTestFile("h1")
    );
    await uploadTestObject(token, bucket.name, "h.txt", createTestFile("h2"));
    await expect(
      db.objectVersions.purgeNonCurrentBulk(bucket.id, SYSTEM_USER_ID, true, {
        onBatch: fail,
      })
    ).rejects.toThrow("audit write failed");
    expect(
      await prisma.objectVersion.count({
        where: { objectId: obj.id, deletedAt: null },
      })
    ).toBe(2);
  });

  it("a soft-delete purge batch is undone when its audit entry fails", async () => {
    const bucket = await createTestBucket(token);
    const obj = await uploadTestObject(
      token,
      bucket.name,
      "s.txt",
      createTestFile("s")
    );
    await prisma.object.update({
      where: { id: obj.id },
      data: { deletedAt: new Date(Date.now() - 60_000) },
    });
    await expect(
      db.objects.purgeSoftDeletedObjects(
        bucket.id,
        [obj.id],
        new Date(),
        false,
        fail
      )
    ).rejects.toThrow("audit write failed");
    expect(await prisma.object.findUnique({ where: { id: obj.id } })).not.toBe(
      null
    );
  });
});

describe("lifecycle sweep webhook event", () => {
  let token: string;

  beforeAll(async () => {
    token = await getTestAccessToken();
    await getLifecyclePolicyQueue().pause();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled([
      getLifecyclePolicyQueue().resume(),
      webhookHelpers.cleanupTestEntities(),
      cleanupTestEntities(),
    ]);
  });

  it("commits with the batch, so nothing after the commit can lose it", async () => {
    const endpoint = await webhookHelpers.createTestWebhookEndpoint(
      await webhookHelpers.getCoreEventSubscriberToken(),
      { eventTypes: ["file-service.lifecycle.policy.applied"] }
    );
    const bucket = await createTestBucket(token, { policy: "private" });
    // The event goes to the bucket's organization: the endpoint's.
    await prisma.bucket.update({
      where: { id: bucket.id },
      data: { organizationId: webhookHelpers.getTestOrgId() },
    });
    const key = `event-${Date.now()}.txt`;
    const uploaded = await uploadTestObject(
      token,
      bucket.name,
      key,
      createTestFile("hi", key, "text/plain")
    );
    await prisma.objectVersion.updateMany({
      where: { objectId: uploaded.id },
      data: { createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) },
    });
    await db.lifecyclePolicies.upsert({
      bucketId: bucket.id,
      expireObjectsAfterDays: 1,
      enabled: true,
    });
    // Any transaction opened after the batch commits fails, as a crash would.
    vi.spyOn(db, "$transaction").mockRejectedValue(new Error("crashed"));

    await processLifecycleSweepPolicy(
      fakeJob({ bucketId: bucket.id, continuation: 0 })
    ).catch(() => {});
    vi.restoreAllMocks();

    await webhookHelpers.waitFor(async () => {
      const deliveries = await prisma.webhookDelivery.findMany({
        where: { webhookEndpointId: endpoint.id },
      });
      return deliveries.some(
        (d) =>
          (d.payload as { data?: { entityIds?: string[] } }).data
            ?.entityIds?.[0] === uploaded.id
      );
    }, 15_000);
  });
});
