// @module-tag int
// @module-tag files
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
} from "../../../../../../support/webhooks.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  getTestAccessToken,
  deliveredPayloads,
} from "../../../../../../support/files.js";

describe("GET, PUT and DELETE /v1/files/buckets/:name/lifecycle", () => {
  describe("Bucket access", () => {
    // Everything a bucket creator does here, but no `file-service.admin`: object
    // access has to come from the creator's grant.
    const MEMBER = [
      "file-service.buckets.delete",
      "file-service.objects.delete",
      "file-service.permissions.delete",
      "file-service.shares.delete",
    ];

    const ORG = "bucket-access-org";

    const as = (token?: string) => ({
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      validateStatus: () => true,
    });

    const member = (organizationId: string | null = ORG) =>
      getTestPrincipalToken({
        userId: randomUUID(),
        organizationId,
        permissions: MEMBER,
      });
    let creatorId: string;
    let creatorToken: string;
    let outsiderToken: string;

    beforeAll(async () => {
      creatorId = randomUUID();
      creatorToken = await getTestPrincipalToken({
        userId: creatorId,
        organizationId: ORG,
        permissions: MEMBER,
      });
      outsiderToken = await member();
    });

    afterAll(async () => {
      await cleanupTestEntities();
    });

    describe("lifecycle policy", () => {
      it("is managed by the creator with bucket permissions alone", async () => {
        const userId = randomUUID();
        const token = await getTestPrincipalToken({
          userId,
          organizationId: ORG,
          permissions: ["file-service.buckets.delete"],
        });
        const bucket = await createTestBucket(token);
        const url = `${BASE_URL}/buckets/${bucket.name}/lifecycle`;

        const put = await axios.put(
          url,
          { expireObjectsAfterDays: 30 },
          as(token)
        );
        expect(put.status).toBe(HTTP_STATUS.OK);
        expect((await axios.get(url, as(token))).status).toBe(HTTP_STATUS.OK);
        expect((await axios.delete(url, as(token))).status).toBe(
          HTTP_STATUS.NO_CONTENT
        );
      });

      it("of a public bucket is not readable by a non-member", async () => {
        const bucket = await createTestBucket(creatorToken, {
          policy: "public",
        });
        const url = `${BASE_URL}/buckets/${bucket.name}/lifecycle`;
        await axios.put(url, { expireObjectsAfterDays: 30 }, as(creatorToken));

        expect((await axios.get(url, as(outsiderToken))).status).toBe(
          HTTP_STATUS.FORBIDDEN
        );
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

    describe("Lifecycle policy", () => {
      it("upserts, reads, and deletes a lifecycle policy", async () => {
        const bucket = await createTestBucket(testToken, { policy: "private" });

        const put = await axios.put(
          `${BASE_URL}/buckets/${bucket.name}/lifecycle`,
          { expireObjectsAfterDays: 30, enabled: true },
          { headers: authHeader(testToken) }
        );
        expect(put.status).toBe(HTTP_STATUS.OK);
        expect(put.data.expireObjectsAfterDays).toBe(30);

        const get = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/lifecycle`,
          { headers: authHeader(testToken) }
        );
        expect(get.status).toBe(HTTP_STATUS.OK);

        const del = await axios.delete(
          `${BASE_URL}/buckets/${bucket.name}/lifecycle`,
          { headers: authHeader(testToken) }
        );
        expect(del.status).toBe(HTTP_STATUS.NO_CONTENT);

        const get404 = await axios.get(
          `${BASE_URL}/buckets/${bucket.name}/lifecycle`,
          { headers: authHeader(testToken), validateStatus: () => true }
        );
        expect(get404.status).toBe(HTTP_STATUS.NOT_FOUND);
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
    const delivered = (eventType: string, entityId: string) =>
      deliveredPayloads(endpointId, eventType, entityId);

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

    it("writes no lifecycle audit entry when there was no policy to delete", async () => {
      const bucket = await createTestBucket(token);
      const res = await axios.delete(
        `${BASE_URL}/buckets/${bucket.name}/lifecycle`,
        auth()
      );
      expect(res.status).toBe(HTTP_STATUS.NO_CONTENT);
      expect(
        await prisma.auditLogEntry.count({
          where: { entityType: "lifecyclePolicy", entityId: String(bucket.id) },
        })
      ).toBe(0);
    });
  });
});
