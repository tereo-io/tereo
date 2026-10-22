// @module-tag int
// @module-tag notifications
import { ensureDailyPartitions } from "../../../../utils/partitions.js";
import { getTestPrincipalToken } from "../../../support/principals.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SYSTEM_USER_ID } from "../../../../definitions/index.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../support/coreUrl.js";
import { fetchJson } from "../../../support/http.js";
import { randomBytes, randomUUID } from "crypto";
import {
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

let connectionSlug: string;

let readableBucket: string;

let otherObjectId: string;

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

  const connection = await createConnection({ isDefault: true });
  connectionSlug = connection.slug;

  const filesToken = await getTestAccessToken();
  readableBucket = (await createTestBucket(filesToken)).name;

  await grantTestPermission(filesToken, readableBucket, senderId, {
    canRead: true,
  });

  otherObjectId = await uploadTestObjectAndGetId(
    filesToken,
    readableBucket,
    "docs/other.txt",
    createTestFile(`other ${rand()}`, "other.txt", "text/plain")
  );
});

afterAll(async () => {
  await clean();
  await cleanupTestEntities();
});

describe("POST /v1/notifications", () => {
  describe("accept-time checks", () => {
    it("refuses more than 50 recipients", async () => {
      const recipients = Array.from({ length: 51 }, (_, i) => ({
        address: `r${i}@example.com`,
      }));
      expectError(
        await send(message({ recipients })),
        400,
        "too_many_recipients"
      );
    });

    it("refuses attachments over 20 MB in total", async () => {
      const version = await currentVersion(otherObjectId);
      const blob = version.contentBlob!;
      await prisma.contentBlob.update({
        where: { hash: blob.hash },
        data: { sizeBytes: BigInt(11 * 1024 * 1024) },
      });
      try {
        const attachment = {
          bucket: readableBucket,
          objectId: otherObjectId,
          versionId: version.id,
        };
        expectError(
          await send(message({ attachments: [attachment, attachment] })),
          400,
          "attachments_too_large"
        );
      } finally {
        await prisma.contentBlob.update({
          where: { hash: blob.hash },
          data: { sizeBytes: blob.sizeBytes },
        });
      }
    });
  });
});
