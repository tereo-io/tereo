// @module-tag int
// @module-tag platform
// @module-tag auth
// @module-tag audit
// @module-tag webhooks
// @module-tag files
import { getTestPrincipalToken } from "../../support/principals.js";
import { prisma } from "../../../utils/db/prisma.js";
import { CORE_URL } from "../../support/coreUrl.js";
import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  DEFAULT_ORGANIZATION_ID,
  SYSTEM_USER_ID,
} from "../../../definitions/index.js";
import {
  createTestWebhookEndpoint,
  getCoreEventSubscriberToken,
  waitFor,
} from "../../support/webhooks.js";
import {
  createTestBucket,
  createTestFile,
  uploadTestObject,
  getTestAccessToken as getFilesToken,
} from "../../support/files.js";

// Behaviour that only exists now that auth, files, webhooks and audit share
// one process: work that used to cross a service boundary.

const BASE_URL = CORE_URL;

const adminToken = (perms: string[]) =>
  getTestPrincipalToken({
    organizationId: DEFAULT_ORGANIZATION_ID,
    permissions: perms,
  });

describe("Single service", () => {
  it("returns 404 JSON for unknown paths", async () => {
    const response = await axios.get(`${BASE_URL}/no-such-route`, {
      validateStatus: () => true,
    });
    expect(response.status).toBe(404);
    expect(response.data.error).toBe("not_found");
  });

  it("records auth's audit entries in the same transaction", async () => {
    const response = await axios.post(
      `${BASE_URL}/v1/admin/roles`,
      { name: `test_role_${randomUUID().slice(0, 8)}`, displayName: "Test" },
      {
        headers: {
          Authorization: `Bearer ${await adminToken(["roles.write"])}`,
        },
      }
    );
    expect(response.status).toBe(201);

    const entry = await prisma.auditLogEntry.findFirst({
      where: { entityId: response.data.id, entityType: "Role" },
    });
    expect(entry).toMatchObject({
      action: "CREATE",
      source: "tereo",
      writerUserId: SYSTEM_USER_ID,
    });
  });

  it("fans an auth event out to subscribed webhook endpoints", async () => {
    const endpoint = await createTestWebhookEndpoint(
      await getCoreEventSubscriberToken(DEFAULT_ORGANIZATION_ID),
      { eventTypes: ["auth.role.updated"] }
    );

    const token = await adminToken(["roles.write", "roles.read"]);
    const role = await axios.post(
      `${BASE_URL}/v1/admin/roles`,
      { name: `test_role_${randomUUID().slice(0, 8)}`, displayName: "Before" },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    await axios.patch(
      `${BASE_URL}/v1/admin/roles/${role.data.id}`,
      { displayName: "After" },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // emitTx → core.outbox → reaper → webhook fan-out creates the delivery.
    await waitFor(
      async () =>
        (await prisma.webhookDelivery.count({
          where: {
            webhookEndpointId: endpoint.id,
            eventType: "auth.role.updated",
          },
        })) > 0,
      10_000
    );
  });

  it("serves public-bucket reads under /files without a token", async () => {
    const token = await getFilesToken();
    const bucket = await createTestBucket(token, { policy: "public" });
    const objectKey = `public-${randomUUID()}.txt`;
    await uploadTestObject(
      token,
      bucket.name,
      objectKey,
      createTestFile("hello")
    );

    const response = await axios.get(
      `${BASE_URL}/v1/files/buckets/${bucket.name}/objects/${objectKey}`,
      { validateStatus: () => true }
    );
    expect(response.status).toBe(200);
  });
});
