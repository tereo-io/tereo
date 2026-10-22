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

let disabledSlug: string;

let readableBucket: string;

let objectId: string;
let versionId: string;
let otherObjectId: string;
let otherVersionId: string;

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

  disabledSlug = (await createConnection({ isEnabled: false })).slug;

  const filesToken = await getTestAccessToken();
  readableBucket = (await createTestBucket(filesToken)).name;

  await grantTestPermission(filesToken, readableBucket, senderId, {
    canRead: true,
  });

  objectId = await uploadTestObjectAndGetId(
    filesToken,
    readableBucket,
    "docs/report.txt",
    createTestFile(`report ${rand()}`, "report.txt", "text/plain")
  );
  const version = await currentVersion(objectId);
  versionId = version.id;

  otherObjectId = await uploadTestObjectAndGetId(
    filesToken,
    readableBucket,
    "docs/other.txt",
    createTestFile(`other ${rand()}`, "other.txt", "text/plain")
  );
  otherVersionId = (await currentVersion(otherObjectId)).id;
});

afterAll(async () => {
  await clean();
  await cleanupTestEntities();
});

describe("POST /v1/notifications", () => {
  describe("accept-time checks", () => {
    it("refuses an unknown channel", async () => {
      expectError(
        await send(message({ channel: "pigeon" })),
        400,
        "unknown_channel"
      );
    });

    it("refuses an unknown connection", async () => {
      expectError(
        await send(message({ connection: "nope" })),
        400,
        "unknown_connection"
      );
    });

    it("refuses a disabled connection", async () => {
      expectError(
        await send(message({ connection: disabledSlug })),
        409,
        "connection_disabled"
      );
    });

    it("refuses header injection in the subject", async () => {
      expectError(
        await send(
          message({
            content: { subject: "Hi\r\nBcc: victim@example.com", text: "x" },
          })
        ),
        400,
        "invalid_content"
      );
    });

    it("refuses content with no body", async () => {
      expectError(
        await send(message({ content: { subject: "Hi" } })),
        400,
        "invalid_content"
      );
    });

    it("refuses an address that is not one email address", async () => {
      expectError(
        await send(
          message({
            recipients: [{ address: "a@example.com, b@example.com" }],
          })
        ),
        400,
        "invalid_content"
      );
    });

    it("refuses an unknown recipient option", async () => {
      expectError(
        await send(
          message({
            recipients: [
              { address: "a@example.com" },
              { address: "b@example.com", As: "bcc" },
            ],
          })
        ),
        400,
        "invalid_content"
      );
    });

    it("refuses recipients with no `to`", async () => {
      expectError(
        await send(
          message({ recipients: [{ address: "a@example.com", as: "cc" }] })
        ),
        400,
        "invalid_content"
      );
    });

    it("refuses a line break in an attachment filename", async () => {
      expectError(
        await send(
          message({
            attachments: [
              {
                bucket: readableBucket,
                objectId,
                versionId,
                filename: "a\r\nb.txt",
              },
            ],
          })
        ),
        400,
        "invalid_content"
      );
    });

    it("refuses a `from` the connection does not allow", async () => {
      expectError(
        await send(
          message({
            content: {
              subject: "Hi",
              text: "x",
              from: { address: "ceo@evil.example" },
            },
          })
        ),
        400,
        "sender_not_allowed"
      );
    });

    it("refuses a `replyTo` the connection does not allow", async () => {
      expectError(
        await send(
          message({
            content: {
              subject: "Hi",
              text: "x",
              replyTo: "support@evil.example",
            },
          })
        ),
        400,
        "sender_not_allowed"
      );
    });

    it("accepts a `replyTo` the connection allows", async () => {
      const res = await send(
        message({
          content: { subject: "Hi", text: "x", replyTo: "support@acme.com" },
        })
      );
      expect(res.status, JSON.stringify(res.body)).toBe(202);
    });

    it.each(["<", ">", "@", '"'])(
      "refuses a `from.name` containing %s",
      async (char) => {
        expectError(
          await send(
            message({
              content: {
                subject: "Hi",
                text: "x",
                from: {
                  address: "billing@acme.com",
                  name: `ceo${char}bank.com`,
                },
              },
            })
          ),
          400,
          "invalid_content"
        );
      }
    );

    it("refuses an unknown user", async () => {
      expectError(
        await send(message({ recipients: [{ userId: randomUUID() }] })),
        400,
        "unknown_user"
      );
    });

    it("refuses a user whose stored email is not one address", async () => {
      const user = await prisma.user.create({
        data: {
          email: `victim-${rand()}@corp.com, attacker@evil.com`,
          passwordHash: "!",
        },
      });
      const before = await prisma.notification.count();
      const res = await send(message({ recipients: [{ userId: user.id }] }));
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain("not a single address");
      expect(await prisma.notification.count()).toBe(before);
    });

    it("refuses a deactivated user", async () => {
      const user = await prisma.user.create({
        data: {
          email: `inactive-${rand()}@example.com`,
          passwordHash: "!",
          isActive: false,
        },
      });
      expectError(
        await send(message({ recipients: [{ userId: user.id }] })),
        400,
        "inactive_user"
      );
    });

    it("refuses a service account", async () => {
      const user = await prisma.user.create({
        data: {
          email: `svc-${rand()}@example.com`,
          passwordHash: "!",
          userType: "service_account",
        },
      });
      expectError(
        await send(message({ recipients: [{ userId: user.id }] })),
        400,
        "inactive_user"
      );
    });

    it("refuses a version that belongs to another object", async () => {
      expectError(
        await send(
          message({
            attachments: [
              { bucket: readableBucket, objectId, versionId: otherVersionId },
            ],
          })
        ),
        400,
        "attachment_not_found"
      );
    });

    it("refuses a delete marker", async () => {
      const marker = await prisma.objectVersion.create({
        data: {
          objectId: otherObjectId,
          isDeleteMarker: true,
          createdBy: SYSTEM_USER_ID,
        },
      });
      expectError(
        await send(
          message({
            attachments: [
              {
                bucket: readableBucket,
                objectId: otherObjectId,
                versionId: marker.id,
              },
            ],
          })
        ),
        400,
        "attachment_not_found"
      );
    });

    it("refuses a version of a trashed object", async () => {
      const trashedId = await uploadTestObjectAndGetId(
        await getTestAccessToken(),
        readableBucket,
        `trash/${rand()}.txt`,
        createTestFile(`trashed ${rand()}`, "trashed.txt", "text/plain")
      );
      const trashedVersion = await currentVersion(trashedId);
      await prisma.object.update({
        where: { id: trashedId },
        data: { deletedAt: new Date() },
      });
      expectError(
        await send(
          message({
            attachments: [
              {
                bucket: readableBucket,
                objectId: trashedId,
                versionId: trashedVersion.id,
              },
            ],
          })
        ),
        400,
        "attachment_not_found"
      );
    });
  });
});
