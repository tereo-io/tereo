// @module-tag int
// @module-tag notifications
import { createAppServiceAccount } from "../../../support/testService.js";
import { ensureDailyPartitions } from "../../../../utils/partitions.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SYSTEM_USER_ID } from "../../../../definitions/index.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../support/coreUrl.js";
import { fetchJson } from "../../../support/http.js";
import { randomBytes, randomUUID } from "crypto";
import axios from "axios";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../../support/principals.js";
import {
  BASE_URL,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  grantTestPermission,
  uploadTestObjectAndGetId,
} from "../../../support/files.js";

const BASE = `${CORE_URL}/v1/notifications`;

const rand = () => randomBytes(4).toString("hex");

const api = (
  method: string,
  path: string,
  token: string | null,
  body?: unknown
) => fetchJson(method, `${BASE}${path}`, token, body);

const settings = {
  host: "127.0.0.1",
  port: 2525,
  security: "none",
  defaultFrom: { address: "billing@acme.com" },
  allowedSenders: ["@acme.com"],
};

const clean = async () => {
  await prisma.notificationDelivery.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.notificationConnection.deleteMany();
};

const createConnection = (over: Record<string, unknown> = {}) =>
  prisma.notificationConnection.create({
    data: {
      channel: "email",
      slug: `c-${rand()}`,
      displayName: "Test",
      settings,
      createdBy: SYSTEM_USER_ID,
      updatedBy: SYSTEM_USER_ID,
      ...over,
    },
  });

let senderToken: string;
let senderId: string;
let otherSenderToken: string;

let noPermToken: string;
let connectionSlug: string;

let forbiddenBucket: string;

let forbiddenObjectId: string;
let forbiddenVersionId: string;

const currentVersion = async (id: string) =>
  (await prisma.objectVersion.findFirstOrThrow({
    where: { objectId: id, isCurrent: true },
    include: { contentBlob: true },
  }))!;

const message = (over: Record<string, unknown> = {}) => ({
  channel: "email",
  connection: connectionSlug,
  recipients: [{ address: "ops@example.com" }],
  content: { subject: "Invoice 1042", text: "Hello" },
  ...over,
});

const send = (body: unknown, token = senderToken) =>
  api("POST", "", token, body);

const expectError = (
  res: { status: number; body: { error?: string } },
  status: number,
  code: string
) => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.body.error).toBe(code);
};

beforeAll(async () => {
  await ensureDailyPartitions("notifications", 0, 1);
  await ensureDailyPartitions("notificationDeliveries", 0, 1);
  await clean();

  senderId = randomUUID();
  senderToken = await getTestPrincipalToken({
    userId: senderId,
    permissions: ["notifications.send", "file-service.objects.read"],
  });
  otherSenderToken = await getTestPrincipalToken({
    permissions: ["notifications.send"],
  });

  noPermToken = await getTestPrincipalToken({
    permissions: ["audit-logs.read"],
  });

  const connection = await createConnection({ isDefault: true });
  connectionSlug = connection.slug;

  const filesToken = await getTestAccessToken();
  forbiddenBucket = (await createTestBucket(filesToken)).name;

  forbiddenObjectId = await uploadTestObjectAndGetId(
    filesToken,
    forbiddenBucket,
    "secret.txt",
    createTestFile(`secret ${rand()}`, "secret.txt", "text/plain")
  );
  forbiddenVersionId = (await currentVersion(forbiddenObjectId)).id;
});

afterAll(async () => {
  await clean();
  await cleanupTestEntities();
});

describe("POST /v1/notifications", () => {
  describe("authorization", () => {
    it("refuses a caller without notifications.send", async () => {
      expectError(await send(message(), noPermToken), 403, "forbidden");
    });
  });

  describe("accept-time checks", () => {
    it("refuses a bucket the sender cannot read", async () => {
      expectError(
        await send(
          message({
            attachments: [
              {
                bucket: forbiddenBucket,
                objectId: forbiddenObjectId,
                versionId: forbiddenVersionId,
              },
            ],
          })
        ),
        403,
        "attachment_forbidden"
      );
    });

    it("takes a public bucket's replaced version only from a grant holder", async () => {
      const filesToken = await getTestAccessToken();
      const bucket = (await createTestBucket(filesToken, { policy: "public" }))
        .name;
      await axios.put(
        `${BASE_URL}/buckets/${bucket}`,
        { versioningEnabled: true },
        { headers: { Authorization: `Bearer ${filesToken}` } }
      );
      const id = await uploadTestObjectAndGetId(
        filesToken,
        bucket,
        "history.txt",
        createTestFile(`first ${rand()}`, "history.txt", "text/plain")
      );
      const replaced = (await currentVersion(id)).id;
      await uploadTestObjectAndGetId(
        filesToken,
        bucket,
        "history.txt",
        createTestFile(`second ${rand()}`, "history.txt", "text/plain")
      );
      const current = (await currentVersion(id)).id;
      expect(current).not.toBe(replaced);
      const attach = (v: string) =>
        message({ attachments: [{ bucket, objectId: id, versionId: v }] });

      // The public bucket serves its current content to anyone...
      const open = await send(attach(current), otherSenderToken);
      expect(open.status, JSON.stringify(open.body)).toBe(202);
      // ...but its history only with a grant.
      expectError(
        await send(attach(replaced), otherSenderToken),
        400,
        "attachment_not_found"
      );
      await grantTestPermission(filesToken, bucket, senderId, {
        canRead: true,
      });
      const granted = await send(attach(replaced));
      expect(granted.status, JSON.stringify(granted.body)).toBe(202);
    });
  });

  describe("organization scope", () => {
    let orgA: string;
    let orgB: string;
    let orgAToken: string;
    let noOrgPersonToken: string;
    let serviceToken: string;
    let adminToken: string;

    beforeAll(async () => {
      orgA = await ensureTestOrganization("notif-scope-a");
      orgB = await ensureTestOrganization("notif-scope-b");
      orgAToken = await getTestPrincipalToken({
        organizationId: orgA,
        permissions: ["notifications.send"],
      });
      noOrgPersonToken = await getTestPrincipalToken({
        organizationId: null,
        permissions: ["notifications.send"],
      });
      const { userId: serviceUserId } =
        await createAppServiceAccount("notif-scope-svc");
      serviceToken = await getTestPrincipalToken({
        userId: serviceUserId,
        organizationId: null,
        permissions: ["notifications.send"],
      });
      adminToken = await getTestPrincipalToken({
        organizationId: null,
        permissions: ["notifications.send", "notifications.admin"],
      });
    });

    it("refuses an organization other than the token's", async () => {
      const before = await prisma.notification.count();
      expectError(
        await send(message({ organizationId: orgB }), orgAToken),
        403,
        "forbidden"
      );
      expect(await prisma.notification.count()).toBe(before);
    });

    it("refuses any organization from a person's token without one", async () => {
      expectError(
        await send(message({ organizationId: orgA }), noOrgPersonToken),
        403,
        "forbidden"
      );
    });

    it("refuses before checking that the organization exists", async () => {
      expectError(
        await send(message({ organizationId: randomUUID() }), orgAToken),
        403,
        "forbidden"
      );
    });

    it("lets an app service's token without one name any organization", async () => {
      const res = await send(message({ organizationId: orgB }), serviceToken);
      expect(res.status, JSON.stringify(res.body)).toBe(202);
    });

    it("lets notifications.admin name any organization", async () => {
      const res = await send(message({ organizationId: orgB }), adminToken);
      expect(res.status, JSON.stringify(res.body)).toBe(202);
    });

    it("lets a token name its own organization", async () => {
      const res = await send(message({ organizationId: orgA }), orgAToken);
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      const row = await prisma.notification.findFirstOrThrow({
        where: { id: res.body.id },
      });
      expect(row.organizationId).toBe(orgA);
    });

    it("lets any sender leave the organization out, defaulting to the token's", async () => {
      for (const [token, expected] of [
        [orgAToken, orgA],
        [noOrgPersonToken, null],
        [serviceToken, null],
      ] as const) {
        for (const organizationId of [undefined, null]) {
          const res = await send(message({ organizationId }), token);
          expect(res.status, JSON.stringify(res.body)).toBe(202);
          const row = await prisma.notification.findFirstOrThrow({
            where: { id: res.body.id },
          });
          expect(row.organizationId).toBe(expected);
        }
      }
    });
  });
});
