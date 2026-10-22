import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { processShareSweepTick } from "../../jobs/shareSweep.js";
import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { TEST_SERVICE_ID } from "../support/testService.js";
import { prisma } from "../../utils/db/prisma.js";
import { CORE_URL } from "../support/coreUrl.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  ensureTestMembership,
  ensureTestUser,
  getTestPrincipalToken,
  testOrgId,
} from "../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  generateUniqueId,
  getTestAccessToken,
  uploadTestObject,
} from "../support/files.js";

// Everything a bucket owner does, but no `file-service.admin`.
const MEMBER = [
  "file-service.buckets.delete",
  "file-service.objects.delete",
  "file-service.permissions.delete",
  "file-service.shares.delete",
];

const ORG = "bucket-owner-access-org";

const as = (token?: string) => ({
  headers: token ? { Authorization: `Bearer ${token}` } : {},
  validateStatus: () => true,
});

/** A user in ORG holding MEMBER, and a token for it. */
const member = async (permissions = MEMBER) => {
  const userId = randomUUID();
  await ensureTestMembership(userId, ORG);
  const token = await getTestPrincipalToken({
    userId,
    organizationId: ORG,
    permissions,
  });
  return { userId, token };
};

const grant = (
  token: string,
  bucketName: string,
  userId: string,
  flags: { canRead?: boolean; canWrite?: boolean; canDelete?: boolean }
) =>
  axios.post(
    `${BASE_URL}/buckets/${bucketName}/permissions`,
    {
      userId,
      canRead: flags.canRead ?? false,
      canWrite: flags.canWrite ?? false,
      canDelete: flags.canDelete ?? false,
    },
    as(token)
  );

const revoke = (token: string, bucketName: string, userId: string) =>
  axios.delete(
    `${BASE_URL}/buckets/${bucketName}/permissions/${userId}`,
    as(token)
  );

const transfer = (token: string, bucketName: string, userId: string) =>
  axios.put(`${BASE_URL}/buckets/${bucketName}/owner`, { userId }, as(token));

const listNames = async (token: string, bucketName: string) => {
  const res = await axios.get(
    `${BASE_URL}/buckets?filter[name]=${bucketName}&filter[name_op]=equals`,
    as(token)
  );
  expect(res.status).toBe(HTTP_STATUS.OK);
  return (res.data.data as { name: string }[]).map((b) => b.name);
};

/** Status of each management call an owner makes. */
const manage = async (token: string, bucketName: string) => {
  const url = `${BASE_URL}/buckets/${bucketName}`;
  return {
    read: (await axios.get(url, as(token))).status,
    update: (await axios.put(url, { description: "tuned" }, as(token))).status,
    lifecycle: (
      await axios.put(
        `${url}/lifecycle`,
        { expireObjectsAfterDays: 30 },
        as(token)
      )
    ).status,
    permissions: (await axios.get(`${url}/permissions`, as(token))).status,
  };
};

describe("Bucket ownership and active grants", () => {
  let adminToken: string;

  beforeAll(async () => {
    adminToken = await getTestPrincipalToken({
      organizationId: ORG,
      permissions: ["file-service.admin"],
    });
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("an owner whose grant an admin revoked", () => {
    it("manages nothing, can't re-grant themselves, and sees no bucket", async () => {
      const owner = await member();
      const bucket = await createTestBucket(owner.token);
      expect(bucket.ownerId).toBe(owner.userId);
      expect(await manage(owner.token, bucket.name)).toEqual({
        read: HTTP_STATUS.OK,
        update: HTTP_STATUS.OK,
        lifecycle: HTTP_STATUS.OK,
        permissions: HTTP_STATUS.OK,
      });

      expect((await revoke(adminToken, bucket.name, owner.userId)).status).toBe(
        HTTP_STATUS.NO_CONTENT
      );

      expect(await manage(owner.token, bucket.name)).toEqual({
        read: HTTP_STATUS.FORBIDDEN,
        update: HTTP_STATUS.FORBIDDEN,
        lifecycle: HTTP_STATUS.FORBIDDEN,
        permissions: HTTP_STATUS.FORBIDDEN,
      });
      expect(
        (
          await grant(owner.token, bucket.name, owner.userId, {
            canRead: true,
            canWrite: true,
            canDelete: true,
          })
        ).status
      ).toBe(HTTP_STATUS.FORBIDDEN);
      const other = await member();
      expect(
        (await grant(owner.token, bucket.name, other.userId, { canRead: true }))
          .status
      ).toBe(HTTP_STATUS.FORBIDDEN);
      expect(
        (
          await axios.delete(
            `${BASE_URL}/buckets/${bucket.name}`,
            as(owner.token)
          )
        ).status
      ).toBe(HTTP_STATUS.FORBIDDEN);
      expect(await listNames(owner.token, bucket.name)).toEqual([]);
    });

    it("manages again once an admin grants it back", async () => {
      const owner = await member();
      const bucket = await createTestBucket(owner.token);
      await revoke(adminToken, bucket.name, owner.userId);

      expect(
        (await grant(adminToken, bucket.name, owner.userId, { canRead: true }))
          .status
      ).toBe(HTTP_STATUS.CREATED);

      expect(await manage(owner.token, bucket.name)).toEqual({
        read: HTTP_STATUS.OK,
        update: HTTP_STATUS.OK,
        lifecycle: HTTP_STATUS.OK,
        permissions: HTTP_STATUS.OK,
      });
      expect(await listNames(owner.token, bucket.name)).toEqual([bucket.name]);
    });

    it("can't make their bucket public", async () => {
      const owner = await member();
      const bucket = await createTestBucket(owner.token);
      await revoke(adminToken, bucket.name, owner.userId);

      const res = await axios.put(
        `${BASE_URL}/buckets/${bucket.name}`,
        { policy: "public" },
        as(owner.token)
      );
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    });
  });

  it("gives a grant holder who isn't the owner the settings but not their management", async () => {
    const owner = await member();
    const reader = await member();
    const bucket = await createTestBucket(owner.token);
    await grant(owner.token, bucket.name, reader.userId, { canRead: true });

    const status = await manage(reader.token, bucket.name);
    expect(status.read).toBe(HTTP_STATUS.OK);
    expect(status.permissions).toBe(HTTP_STATUS.OK);
    expect(status.update).toBe(HTTP_STATUS.FORBIDDEN);
    expect(status.lifecycle).toBe(HTTP_STATUS.FORBIDDEN);
  });

  describe("PUT /buckets/:name/owner", () => {
    it("is for file-service.admin only", async () => {
      const owner = await member();
      const other = await member();
      const bucket = await createTestBucket(owner.token);

      const res = await transfer(owner.token, bucket.name, other.userId);
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      const row = await prisma.bucket.findUniqueOrThrow({
        where: { id: bucket.id },
      });
      expect(row.ownerId).toBe(owner.userId);
    });

    it("hands management to the new owner, with a full grant", async () => {
      const owner = await member();
      const next = await member();
      const bucket = await createTestBucket(owner.token);
      await uploadTestObject(
        owner.token,
        bucket.name,
        "doc.txt",
        createTestFile("hello")
      );

      const res = await transfer(adminToken, bucket.name, next.userId);
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.data).toMatchObject({
        ownerId: next.userId,
        owner: { id: next.userId },
        createdBy: owner.userId,
      });

      const nextGrant = await prisma.bucketPermission.findUniqueOrThrow({
        where: {
          bucketId_userId: { bucketId: bucket.id, userId: next.userId },
        },
      });
      expect(nextGrant).toMatchObject({
        canRead: true,
        canWrite: true,
        canDelete: true,
        revokedAt: null,
      });
      expect(await manage(next.token, bucket.name)).toEqual({
        read: HTTP_STATUS.OK,
        update: HTTP_STATUS.OK,
        lifecycle: HTTP_STATUS.OK,
        permissions: HTTP_STATUS.OK,
      });
      expect(await listNames(next.token, bucket.name)).toEqual([bucket.name]);

      // The old owner keeps the grant's object access, not the management.
      const old = await manage(owner.token, bucket.name);
      expect(old.update).toBe(HTTP_STATUS.FORBIDDEN);
      expect(old.lifecycle).toBe(HTTP_STATUS.FORBIDDEN);
      const read = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/doc.txt`,
        as(owner.token)
      );
      expect(read.status).toBe(HTTP_STATUS.OK);
      await uploadTestObject(
        owner.token,
        bucket.name,
        "more.txt",
        createTestFile("more")
      );

      const entries = await prisma.auditLogEntry.findMany({
        where: {
          entityType: "bucket",
          entityId: String(bucket.id),
          action: "UPDATE",
        },
      });
      expect(
        entries.filter((e) => e.changes && "ownerId" in (e.changes as object))
      ).toMatchObject([
        { changes: { ownerId: { old: owner.userId, new: next.userId } } },
      ]);
    });

    it("revives a new owner's revoked grant, and keeps an active one as it is", async () => {
      const owner = await member();
      const reader = await member();
      const bucket = await createTestBucket(owner.token);
      await grant(owner.token, bucket.name, reader.userId, { canRead: true });

      expect(
        (await transfer(adminToken, bucket.name, reader.userId)).status
      ).toBe(HTTP_STATUS.OK);
      const kept = await prisma.bucketPermission.findUniqueOrThrow({
        where: {
          bucketId_userId: { bucketId: bucket.id, userId: reader.userId },
        },
      });
      expect(kept).toMatchObject({ canRead: true, canWrite: false });

      await revoke(adminToken, bucket.name, owner.userId);
      expect(
        (await transfer(adminToken, bucket.name, owner.userId)).status
      ).toBe(HTTP_STATUS.OK);
      const revived = await prisma.bucketPermission.findUniqueOrThrow({
        where: {
          bucketId_userId: { bucketId: bucket.id, userId: owner.userId },
        },
      });
      expect(revived).toMatchObject({
        canRead: true,
        canWrite: true,
        canDelete: true,
        revokedAt: null,
      });
    });

    it("refuses a user outside the bucket's organization, or none", async () => {
      const owner = await member();
      const bucket = await createTestBucket(owner.token);
      const outsider = await ensureTestUser(randomUUID());

      const res = await transfer(adminToken, bucket.name, outsider);
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(res.data.error).toBe("user_not_in_organization");

      const unknown = await transfer(adminToken, bucket.name, randomUUID());
      expect(unknown.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(unknown.data.error).toBe("unknown_user");
    });

    it("refuses a deactivated user", async () => {
      const owner = await member();
      const next = await member();
      const bucket = await createTestBucket(owner.token);
      await prisma.user.update({
        where: { id: next.userId },
        data: { isActive: false },
      });

      const res = await transfer(adminToken, bucket.name, next.userId);
      expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(res.data.error).toBe("user_inactive");
    });

    it("refuses a declared bucket", async () => {
      const serviceUserId = await ensureTestUser(randomUUID());
      const declared = await prisma.bucket.create({
        data: {
          name: `test-bucket-${generateUniqueId()}`,
          policy: "private",
          serviceId: TEST_SERVICE_ID,
          createdBy: serviceUserId,
          ownerId: serviceUserId,
        },
      });
      try {
        const next = await ensureTestUser(randomUUID());
        const res = await transfer(
          await getTestAccessToken(),
          declared.name,
          next
        );
        expect(res.status).toBe(HTTP_STATUS.CONFLICT);
        expect(res.data.error).toBe("bucket_declared");
      } finally {
        await prisma.bucket.delete({ where: { id: declared.id } });
      }
    });
  });

  describe("PATCH /objects/by-id/:id deleteAfter", () => {
    const patch = (
      token: string,
      bucketName: string,
      id: string,
      body: Record<string, unknown>
    ) =>
      axios.patch(
        `${BASE_URL}/buckets/${bucketName}/objects/by-id/${id}`,
        body,
        as(token)
      );

    it("takes delete access to set, and only write to clear", async () => {
      const owner = await member();
      const writer = await member();
      const deleter = await member();
      const bucket = await createTestBucket(owner.token);
      await grant(owner.token, bucket.name, writer.userId, {
        canRead: true,
        canWrite: true,
      });
      await grant(owner.token, bucket.name, deleter.userId, {
        canRead: true,
        canWrite: true,
        canDelete: true,
      });
      const object = await uploadTestObject(
        owner.token,
        bucket.name,
        "ttl.txt",
        createTestFile("ttl")
      );
      const soon = new Date(Date.now() + 60_000).toISOString();

      const refused = await patch(writer.token, bucket.name, object.id, {
        deleteAfter: soon,
      });
      expect(refused.status).toBe(HTTP_STATUS.FORBIDDEN);
      let row = await prisma.object.findUniqueOrThrow({
        where: { id: object.id },
      });
      expect(row.deleteAfter).toBeNull();

      const set = await patch(deleter.token, bucket.name, object.id, {
        deleteAfter: soon,
      });
      expect(set.status).toBe(HTTP_STATUS.OK);
      expect(set.data.deleteAfter).toBe(soon);

      const cleared = await patch(writer.token, bucket.name, object.id, {
        deleteAfter: null,
      });
      expect(cleared.status).toBe(HTTP_STATUS.OK);
      row = await prisma.object.findUniqueOrThrow({ where: { id: object.id } });
      expect(row.deleteAfter).toBeNull();

      const tags = await patch(writer.token, bucket.name, object.id, {
        tags: ["kept"],
      });
      expect(tags.status).toBe(HTTP_STATUS.OK);
    });

    it("takes the objects.delete role permission with the grant", async () => {
      const owner = await member();
      const writer = await member(["file-service.objects.write"]);
      const bucket = await createTestBucket(owner.token);
      await grant(owner.token, bucket.name, writer.userId, {
        canRead: true,
        canWrite: true,
        canDelete: true,
      });
      const object = await uploadTestObject(
        owner.token,
        bucket.name,
        "ttl.txt",
        createTestFile("ttl")
      );

      const res = await patch(writer.token, bucket.name, object.id, {
        deleteAfter: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    });
  });

  describe("shares on a public bucket", () => {
    it("are managed only with a grant", async () => {
      const owner = await member();
      const stranger = await member();
      const bucket = await createTestBucket(owner.token, { policy: "public" });
      const object = await uploadTestObject(
        owner.token,
        bucket.name,
        "pub.txt",
        createTestFile("pub")
      );
      const sharesUrl = `${BASE_URL}/buckets/${bucket.name}/shares`;
      const share = await axios.post(
        sharesUrl,
        { kind: "OBJECT", objectId: object.id },
        as(owner.token)
      );
      expect(share.status).toBe(HTTP_STATUS.CREATED);

      // Anyone may download from the bucket; that is not a grant.
      const download = await axios.get(
        `${BASE_URL}/buckets/${bucket.name}/objects/pub.txt`,
        as(stranger.token)
      );
      expect(download.status).toBe(HTTP_STATUS.OK);

      const create = await axios.post(
        sharesUrl,
        { kind: "OBJECT", objectId: object.id },
        as(stranger.token)
      );
      expect(create.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect((await axios.get(sharesUrl, as(stranger.token))).status).toBe(
        HTTP_STATUS.FORBIDDEN
      );
      expect(
        (
          await axios.get(
            `${sharesUrl}/by-id/${share.data.id}`,
            as(stranger.token)
          )
        ).status
      ).toBe(HTTP_STATUS.FORBIDDEN);

      await grant(owner.token, bucket.name, stranger.userId, { canRead: true });
      expect((await axios.get(sharesUrl, as(stranger.token))).status).toBe(
        HTTP_STATUS.OK
      );
    });
  });

  describe("PATCH /shares/by-id/:id", () => {
    it("is refused to a creator whose read grant was revoked", async () => {
      const owner = await member();
      const reader = await member();
      const bucket = await createTestBucket(owner.token);
      const object = await uploadTestObject(
        owner.token,
        bucket.name,
        "doc.txt",
        createTestFile("doc")
      );
      await grant(owner.token, bucket.name, reader.userId, { canRead: true });
      const share = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        { kind: "OBJECT", objectId: object.id },
        as(reader.token)
      );
      expect(share.status).toBe(HTTP_STATUS.CREATED);
      await revoke(owner.token, bucket.name, reader.userId);

      const res = await axios.patch(
        `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${share.data.id}`,
        { expiresAt: null },
        as(reader.token)
      );
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it("audits a changed password without the password", async () => {
      const owner = await member();
      const bucket = await createTestBucket(owner.token);
      const object = await uploadTestObject(
        owner.token,
        bucket.name,
        "doc.txt",
        createTestFile("doc")
      );
      const share = await axios.post(
        `${BASE_URL}/buckets/${bucket.name}/shares`,
        { kind: "OBJECT", objectId: object.id, password: "first-secret" },
        as(owner.token)
      );
      const res = await axios.patch(
        `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${share.data.id}`,
        { password: "second-secret" },
        as(owner.token)
      );
      expect(res.status).toBe(HTTP_STATUS.OK);

      const entry = await prisma.auditLogEntry.findFirstOrThrow({
        where: {
          entityType: "share",
          entityId: share.data.id,
          action: "UPDATE",
        },
      });
      expect(entry.metadata).toMatchObject({ passwordChanged: true });
      expect(JSON.stringify(entry)).not.toContain("second-secret");

      await axios.patch(
        `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${share.data.id}`,
        { note: "no password" },
        as(owner.token)
      );
      const later = await prisma.auditLogEntry.findFirstOrThrow({
        where: {
          entityType: "share",
          entityId: share.data.id,
          action: "UPDATE",
        },
        orderBy: { createdAt: "desc" },
      });
      expect(later.metadata).toMatchObject({ passwordChanged: false });
    });
  });

  it("reports a deactivated creator's share as not serving", async () => {
    const owner = await member();
    const creator = await member();
    const bucket = await createTestBucket(owner.token);
    const object = await uploadTestObject(
      owner.token,
      bucket.name,
      "doc.txt",
      createTestFile("doc")
    );
    await grant(owner.token, bucket.name, creator.userId, { canRead: true });
    const share = await axios.post(
      `${BASE_URL}/buckets/${bucket.name}/shares`,
      { kind: "OBJECT", objectId: object.id },
      as(creator.token)
    );
    expect(share.data.status).toBe("active");
    await prisma.user.update({
      where: { id: creator.userId },
      data: { isActive: false },
    });

    const res = await axios.get(
      `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${share.data.id}`,
      as(owner.token)
    );
    expect(res.status).toBe(HTTP_STATUS.OK);
    expect(res.data.status).toBe("creator_inactive");
    expect(res.data.creator).toEqual({
      id: creator.userId,
      email: expect.any(String),
      name: expect.any(String),
    });
  });

  it("audits the share sweep's deletes, as the system user", async () => {
    const owner = await member();
    const bucket = await createTestBucket(owner.token);
    const object = await uploadTestObject(
      owner.token,
      bucket.name,
      "doc.txt",
      createTestFile("doc")
    );
    const share = await axios.post(
      `${BASE_URL}/buckets/${bucket.name}/shares`,
      { kind: "OBJECT", objectId: object.id },
      as(owner.token)
    );
    await prisma.share.update({
      where: { id: share.data.id },
      data: { revokedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) },
    });

    await processShareSweepTick();

    expect(
      await prisma.share.findUnique({ where: { id: share.data.id } })
    ).toBeNull();
    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: { entityType: "shareSweep", entityId: String(bucket.id) },
    });
    expect(entry).toMatchObject({
      action: "DELETE",
      userId: SYSTEM_USER_ID,
      organizationId: testOrgId(ORG),
    });
    expect(entry.metadata).toMatchObject({
      bucketName: bucket.name,
      processed: 1,
      shares: [{ id: share.data.id, kind: "OBJECT" }],
    });
  });

  it("revokes a removed member's grants on the organization's buckets", async () => {
    const owner = await member();
    const leaving = await member();
    const bucket = await createTestBucket(owner.token);
    await grant(owner.token, bucket.name, leaving.userId, {
      canRead: true,
      canWrite: true,
    });
    const orgAdmin = await getTestPrincipalToken({ permissions: ["admin"] });

    const res = await axios.delete(
      `${CORE_URL}/v1/admin/organizations/${testOrgId(ORG)}/members/${leaving.userId}`,
      as(orgAdmin)
    );
    expect(res.status).toBe(HTTP_STATUS.NO_CONTENT);

    const row = await prisma.bucketPermission.findUniqueOrThrow({
      where: {
        bucketId_userId: { bucketId: bucket.id, userId: leaving.userId },
      },
    });
    expect(row.revokedAt).not.toBeNull();
    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        entityType: "bucketPermission",
        entityId: String(row.id),
        action: "DELETE",
      },
    });
    expect(entry.metadata).toMatchObject({
      targetUserId: leaving.userId,
      reason: "organization_member_removed",
    });

    // The owner's grant stays.
    const kept = await prisma.bucketPermission.findUniqueOrThrow({
      where: {
        bucketId_userId: { bucketId: bucket.id, userId: owner.userId },
      },
    });
    expect(kept.revokedAt).toBeNull();
  });

  describe("websocket push", () => {
    /** A socket.io client over a plain WebSocket, collecting events. */
    const connect = (token: string) => {
      const ws = new WebSocket(
        `${CORE_URL.replace(/^http/, "ws")}/ws/?EIO=4&transport=websocket`
      );
      const events: { name: string; payload: unknown }[] = [];
      const connected = new Promise<void>((resolve, reject) => {
        ws.addEventListener("message", ({ data }) => {
          const packet = String(data);
          if (packet.startsWith("0")) ws.send(`40${JSON.stringify({ token })}`);
          else if (packet === "2") ws.send("3");
          else if (packet.startsWith("40")) resolve();
          else if (packet.startsWith("44")) reject(new Error(packet));
          else if (packet.startsWith("42")) {
            const [name, payload] = JSON.parse(packet.slice(2)) as [
              string,
              unknown,
            ];
            events.push({ name, payload });
          }
        });
        ws.addEventListener("close", () => reject(new Error("closed")));
      });
      return { connected, events, close: () => ws.close() };
    };

    const received = async (
      events: { name: string; payload: unknown }[],
      count: number
    ) => {
      const deadline = Date.now() + 5000;
      const matching = () =>
        events.filter((e) => e.name === "files:bucket-access:changed");
      while (matching().length < count && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return matching();
    };

    it("tells the user whose grant was given or revoked", async () => {
      const owner = await member();
      const reader = await member();
      const bucket = await createTestBucket(owner.token);
      const socket = connect(reader.token);
      try {
        await socket.connected;
        await grant(owner.token, bucket.name, reader.userId, { canRead: true });
        await revoke(owner.token, bucket.name, reader.userId);

        const events = await received(socket.events, 2);
        expect(events).toHaveLength(2);
        expect(events[0].payload).toMatchObject({ bucketName: bucket.name });
      } finally {
        socket.close();
      }
    });
  });
});
