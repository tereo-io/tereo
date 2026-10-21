import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureDailyPartitions } from "../../utils/partitions.js";
import { createAppServiceAccount } from "../utils/testService.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { waitFor } from "../webhooks/utils/test-helpers.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomBytes, randomUUID } from "crypto";
import { CORE_URL } from "../utils/coreUrl.js";
import { fetchJson } from "../utils/http.js";
import axios from "axios";
import {
  closeNotificationQueues,
  getNotificationQueue,
} from "../../jobs/notificationQueues.js";
import {
  BASE_URL,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  getTestAccessToken,
  grantTestPermission,
  uploadTestObjectAndGetId,
} from "../files/utils/test-helpers.js";
import {
  ensureTestOrganization,
  ensureTestUser,
  getTestPrincipalToken,
} from "../utils/principals.js";

const BASE = `${CORE_URL}/v1/notifications`;

// The delivery worker does not run under test, so a dispatched job waits.
const waitForDeliveryJob = async (deliveryId: string) => {
  const queue = getNotificationQueue("email");
  await waitFor(async () => (await queue.getJob(deliveryId)) !== undefined);
  return (await queue.getJob(deliveryId))!;
};

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
let readerToken: string;
let noPermToken: string;
let connectionSlug: string;
let connectionId: string;
let disabledSlug: string;
let recipientUserId: string;
let recipientEmail: string;
let readableBucket: string;
let forbiddenBucket: string;
let objectId: string;
let versionId: string;
let otherObjectId: string;
let otherVersionId: string;
let forbiddenObjectId: string;
let forbiddenVersionId: string;
let objectSize: number;

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
  readerToken = await getTestPrincipalToken({
    permissions: ["notifications.read"],
  });
  noPermToken = await getTestPrincipalToken({
    permissions: ["audit-logs.read"],
  });

  const connection = await createConnection({ isDefault: true });
  connectionSlug = connection.slug;
  connectionId = connection.id;
  disabledSlug = (await createConnection({ isEnabled: false })).slug;

  recipientUserId = await ensureTestUser(randomUUID());
  recipientEmail = (
    await prisma.user.findUniqueOrThrow({ where: { id: recipientUserId } })
  ).email;

  const filesToken = await getTestAccessToken();
  readableBucket = (await createTestBucket(filesToken)).name;
  forbiddenBucket = (await createTestBucket(filesToken)).name;
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
  objectSize = Number(version.contentBlob!.sizeBytes);

  otherObjectId = await uploadTestObjectAndGetId(
    filesToken,
    readableBucket,
    "docs/other.txt",
    createTestFile(`other ${rand()}`, "other.txt", "text/plain")
  );
  otherVersionId = (await currentVersion(otherObjectId)).id;

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
  await closeNotificationQueues();
});

describe("POST /v1/notifications", () => {
  describe("authorization", () => {
    it("requires authentication", async () => {
      expect((await send(message(), null as unknown as string)).status).toBe(
        401
      );
    });

    it("refuses a caller without notifications.send", async () => {
      expectError(await send(message(), noPermToken), 403, "forbidden");
    });
  });

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

  describe("accepted", () => {
    let id: string;

    it("answers 202 and writes the notification, its delivery, an audit entry and an outbox row", async () => {
      const res = await send(
        message({
          recipients: [
            { address: "ops@example.com" },
            { userId: recipientUserId, as: "cc" },
          ],
          attachments: [{ bucket: readableBucket, objectId, versionId }],
        })
      );
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      expect(res.body).toEqual({ id: expect.any(String), status: "pending" });
      id = res.body.id;

      const row = await prisma.notification.findFirstOrThrow({
        where: { id },
        include: { deliveries: true },
      });
      expect(row).toMatchObject({
        channel: "email",
        connectionId,
        senderUserId: senderId,
        status: "pending",
        content: { subject: "Invoice 1042", text: "Hello" },
        summary: "Invoice 1042",
        attachments: [
          {
            bucket: readableBucket,
            objectId,
            versionId,
            filename: "report.txt",
            contentType: "text/plain",
            size: objectSize,
          },
        ],
      });
      expect(row.deliveries).toHaveLength(1);
      expect(row.deliveries[0].status).toBe("pending");
      expect(row.deliveries[0].recipients).toEqual([
        { address: "ops@example.com", as: "to" },
        { address: recipientEmail, as: "cc", userId: recipientUserId },
      ]);

      const audit = await prisma.auditLogEntry.findFirst({
        where: { entityType: "Notification", entityId: id },
      });
      expect(audit).toMatchObject({ action: "CREATE", userId: senderId });

      // The server's reaper may have dispatched the outbox row and deleted it
      // already. Dispatch finds the notification by the payload's id and
      // createdAt, so its delivery being queued shows the row was right.
      const outbox = await prisma.$queryRaw<{ payload: unknown }[]>`
        SELECT payload FROM "core"."outbox"
        WHERE destination = 'notification' AND payload->>'notificationId' = ${id}`;
      for (const r of outbox) {
        expect(r.payload).toEqual({
          notificationId: id,
          createdAt: row.createdAt.toISOString(),
        });
      }
      expect(outbox.length).toBeLessThanOrEqual(1);
      const job = await waitForDeliveryJob(row.deliveries[0].id);
      expect(job.data).toMatchObject({
        deliveryId: row.deliveries[0].id,
        notificationId: id,
        notificationCreatedAt: row.createdAt.toISOString(),
      });
    });

    it("lets the sender read their own send, with deliveries", async () => {
      const res = await api("GET", `/${id}`, senderToken);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({
        id,
        status: "pending",
        summary: "Invoice 1042",
      });
      expect(res.body.deliveries).toHaveLength(1);
      expect(res.body).not.toHaveProperty("content");
    });

    it("lets notifications.read read any send", async () => {
      expect((await api("GET", `/${id}`, readerToken)).status).toBe(200);
    });

    it("hides another sender's send from a send-only caller", async () => {
      expectError(
        await api("GET", `/${id}`, otherSenderToken),
        404,
        "not_found"
      );
    });

    it("answers 404 for an unknown id", async () => {
      expectError(
        await api("GET", `/${randomUUID()}`, readerToken),
        404,
        "not_found"
      );
    });

    it("refuses a caller with neither send nor read", async () => {
      expect((await api("GET", `/${id}`, noPermToken)).status).toBe(403);
    });
  });

  describe("idempotency", () => {
    it("replays the first result for the same key and body", async () => {
      const body = message({ idempotencyKey: randomUUID() });
      const first = await send(body);
      const second = await send(body);
      expect(first.status, JSON.stringify(first.body)).toBe(202);
      expect(second.status).toBe(202);
      expect(second.body.id).toBe(first.body.id);
      expect(
        await prisma.notification.count({ where: { id: first.body.id } })
      ).toBe(1);
      expect(
        await prisma.auditLogEntry.count({
          where: { entityType: "Notification", entityId: first.body.id },
        })
      ).toBe(1);
    });

    it("refuses the same key with a different body", async () => {
      const idempotencyKey = randomUUID();
      expect((await send(message({ idempotencyKey }))).status).toBe(202);
      expectError(
        await send(
          message({
            idempotencyKey,
            content: { subject: "Other", text: "x" },
          })
        ),
        422,
        "idempotency_key_conflict"
      );
    });

    it("refuses the same key with a different, invalid body", async () => {
      const idempotencyKey = randomUUID();
      expect((await send(message({ idempotencyKey }))).status).toBe(202);
      expectError(
        await send(
          message({ idempotencyKey, content: { subject: "No body" } })
        ),
        422,
        "idempotency_key_conflict"
      );
    });

    it("replays the first result after a recipient is deactivated", async () => {
      const user = await prisma.user.create({
        data: { email: `replay-${rand()}@example.com`, passwordHash: "!" },
      });
      const body = message({
        idempotencyKey: randomUUID(),
        recipients: [{ userId: user.id }],
      });
      const first = await send(body);
      expect(first.status, JSON.stringify(first.body)).toBe(202);

      const sent = () =>
        prisma.notification.count({ where: { senderUserId: senderId } });
      const before = await sent();

      await prisma.user.update({
        where: { id: user.id },
        data: { isActive: false },
      });
      const second = await send(body);
      expect(second.status, JSON.stringify(second.body)).toBe(202);
      expect(second.body.id).toBe(first.body.id);
      expect(await sent()).toBe(before);
    });

    it("replays the first result after the named connection is disabled", async () => {
      const connection = await createConnection();
      const body = message({
        idempotencyKey: randomUUID(),
        connection: connection.slug,
      });
      const first = await send(body);
      expect(first.status, JSON.stringify(first.body)).toBe(202);

      await prisma.notificationConnection.update({
        where: { id: connection.id },
        data: { isEnabled: false },
      });
      const second = await send(body);
      expect(second.status, JSON.stringify(second.body)).toBe(202);
      expect(second.body.id).toBe(first.body.id);
      expect(
        await prisma.notification.count({
          where: { connectionId: connection.id },
        })
      ).toBe(1);
    });
  });

  describe("with no connection", () => {
    it("still accepts a send when the channel has no default and none is named", async () => {
      await clean();
      const res = await send(message({ connection: undefined }));
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      const row = await prisma.notification.findFirstOrThrow({
        where: { id: res.body.id },
      });
      expect(row).toMatchObject({ connectionId: null, status: "pending" });
    });
  });
});
