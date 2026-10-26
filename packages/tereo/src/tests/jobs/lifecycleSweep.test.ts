// @module-tag int
// @module-tag files
// @module-tag job
import * as webhookHelpers from "../support/webhooks.js";
import { prisma } from "../../utils/db/prisma.js";
import db from "../../utils/db/index.js";
import { randomUUID } from "crypto";
import type { Job } from "bullmq";
import axios from "axios";
import {
  processLifecycleSweepOrchestrator,
  processLifecycleSweepPerObjectTtl,
  processLifecycleSweepPolicy,
} from "../../jobs/lifecycleSweep.js";
import {
  getLifecycleOrchestratorQueue,
  getLifecyclePerObjectTtlQueue,
  getLifecyclePolicyQueue,
} from "../../jobs/queues.js";
import {
  BASE_URL,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  uploadTestObject,
} from "../support/files.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

describe("processLifecycleSweepOrchestrator, processLifecycleSweepPerObjectTtl and processLifecycleSweepPolicy", () => {
  describe("lifecycle sweep fan-out", () => {
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
        ["wait", "delayed", "active"],
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
        ["wait", "delayed", "active", "completed"],
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

  describe("lifecycle sweep webhook event", () => {
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

  describe("lifecycle sweep stages", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    const fakeJob = <T>(data: T): Job<T> =>
      ({
        id: `fake-${randomUUID()}`,
        data,
        updateProgress: async () => undefined,
      }) as unknown as Job<T>;

    const sweep = (bucketId: number) =>
      processLifecycleSweepPolicy(fakeJob({ bucketId, continuation: 0 }));

    const usage = async (bucketId: number) =>
      (await prisma.bucket.findUniqueOrThrow({ where: { id: bucketId } }))
        .currentUsageBytes;
    let token: string;
    const auth = () => ({
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });

    const versionedBucket = async () => {
      const bucket = await createTestBucket(token);
      const res = await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        { versioningEnabled: true },
        auth()
      );
      expect(res.status).toBe(200);
      return bucket as { id: number; name: string };
    };

    beforeAll(async () => {
      token = await getTestAccessToken();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    it("purges soft-deleted objects at once with purgeSoftDeletedAfterDays 0, refunding usage", async () => {
      const bucket = await versionedBucket();
      const content = `purge ${randomUUID()}`;
      const obj = await uploadTestObject(
        token,
        bucket.name,
        "gone.txt",
        createTestFile(content)
      );
      const del = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}`,
        auth()
      );
      expect(del.status).toBe(204);
      expect(await usage(bucket.id)).toBe(BigInt(Buffer.byteLength(content)));

      await db.lifecyclePolicies.upsert({
        bucketId: bucket.id,
        purgeSoftDeletedAfterDays: 0,
      });
      await sweep(bucket.id);

      expect(await prisma.object.findUnique({ where: { id: obj.id } })).toBe(
        null
      );
      expect(await usage(bucket.id)).toBe(0n);
    });

    it("expires a version by how long it has been non-current, not by its age", async () => {
      const bucket = await versionedBucket();
      const old = `old ${randomUUID()}`;
      const obj = await uploadTestObject(
        token,
        bucket.name,
        "doc.txt",
        createTestFile(old)
      );
      const first = await prisma.objectVersion.findFirstOrThrow({
        where: { objectId: obj.id, isCurrent: true },
      });
      // Uploaded a year ago, overwritten now.
      await prisma.objectVersion.update({
        where: { id: first.id },
        data: { createdAt: new Date(Date.now() - 365 * DAY_MS) },
      });
      await uploadTestObject(
        token,
        bucket.name,
        "doc.txt",
        createTestFile(`new ${randomUUID()}`)
      );
      const replaced = await prisma.objectVersion.findUniqueOrThrow({
        where: { id: first.id },
      });
      expect(replaced.isCurrent).toBe(false);
      expect(replaced.noncurrentSince).not.toBeNull();
      expect(Date.now() - replaced.noncurrentSince!.getTime()).toBeLessThan(
        60_000
      );

      await db.lifecyclePolicies.upsert({
        bucketId: bucket.id,
        expireVersionsAfterDays: 30,
      });
      const before = await usage(bucket.id);
      await sweep(bucket.id);
      expect(
        (
          await prisma.objectVersion.findUniqueOrThrow({
            where: { id: first.id },
          })
        ).deletedAt
      ).toBeNull();

      // 31 days after the overwrite.
      await prisma.objectVersion.update({
        where: { id: first.id },
        data: { noncurrentSince: new Date(Date.now() - 31 * DAY_MS) },
      });
      await sweep(bucket.id);
      expect(
        (
          await prisma.objectVersion.findUniqueOrThrow({
            where: { id: first.id },
          })
        ).deletedAt
      ).not.toBeNull();
      expect(await usage(bucket.id)).toBe(
        before - BigInt(Buffer.byteLength(old))
      );
    });

    it("marks the replaced version non-current on a delete marker and a restore", async () => {
      const bucket = await versionedBucket();
      const obj = await uploadTestObject(
        token,
        bucket.name,
        "r.txt",
        createTestFile(`r ${randomUUID()}`)
      );
      const first = await prisma.objectVersion.findFirstOrThrow({
        where: { objectId: obj.id, isCurrent: true },
      });
      const del = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}`,
        auth()
      );
      expect(del.status).toBe(204);
      expect(
        (
          await prisma.objectVersion.findUniqueOrThrow({
            where: { id: first.id },
          })
        ).noncurrentSince
      ).not.toBeNull();

      const marker = await prisma.objectVersion.findFirstOrThrow({
        where: { objectId: obj.id, isCurrent: true },
      });
      expect(marker.isDeleteMarker).toBe(true);
      expect(marker.noncurrentSince).toBeNull();
      const restore = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${obj.id}/versions/${first.id}/restore`,
        {},
        auth()
      );
      expect(restore.status).toBeLessThan(300);
      const restored = await prisma.objectVersion.findFirstOrThrow({
        where: { objectId: obj.id, isCurrent: true },
      });
      expect(restored.noncurrentSince).toBeNull();
      expect(
        (
          await prisma.objectVersion.findUniqueOrThrow({
            where: { id: marker.id },
          })
        ).noncurrentSince
      ).not.toBeNull();
    });

    it("does not list a deleted bucket's enabled policy", async () => {
      const bucket = await createTestBucket(token);
      await db.lifecyclePolicies.upsert({
        bucketId: bucket.id,
        expireObjectsAfterDays: 1,
      });
      expect(
        (await db.lifecyclePolicies.listEnabled()).map((p) => p.bucketId)
      ).toContain(bucket.id);

      await prisma.bucket.update({
        where: { id: bucket.id },
        data: { deletedAt: new Date() },
      });
      expect(
        (await db.lifecyclePolicies.listEnabled()).map((p) => p.bucketId)
      ).not.toContain(bucket.id);
    });
  });
});
