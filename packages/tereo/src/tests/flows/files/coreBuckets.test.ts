// @module-tag int
// @module-tag files
import { brandingPrincipal, storeTestImage } from "../../support/branding.js";
import { BASE_URL, getTestAccessToken } from "../../support/files.js";
import { BRANDING_BUCKET } from "../../../utils/branding/storage.js";
import { getAccessTokenForUser } from "../../support/auth/login.js";
import { getTestPrincipalToken } from "../../support/principals.js";
import { sign as presignSign } from "../../../utils/presigning.js";
import { createTestClient } from "../../support/auth/clients.js";
import { SYSTEM_USER_ID } from "../../../definitions/index.js";
import { createTestUser } from "../../support/auth/users.js";
import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { prisma } from "../../../utils/db/prisma.js";
import { CORE_URL } from "../../support/coreUrl.js";

// Core's own buckets are written only by core's modules: through the files
// API every write is `409 bucket_managed_by_core`, `file-service.admin`
// included, while reads go on.

const PHOTOS = "auth-service-user-photos";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

let admin: string;
let objectId: string;
let objectKey: string;
let deleteAfter: Date | null;

const call = async (
  method: string,
  path: string,
  body?: unknown,
  bucket = BRANDING_BUCKET
) => {
  const response = await fetch(`${BASE_URL}/buckets/${bucket}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${admin}`,
      "Idempotency-Key": randomUUID(),
      ...(body instanceof FormData || body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  // A download answers with the object's bytes, not JSON.
  if (!response.headers.get("content-type")?.startsWith("application/json")) {
    await response.arrayBuffer();
    return { status: response.status, data: null };
  }
  const data = (await response.json()) as Record<string, unknown>;
  return { status: response.status, data };
};

beforeAll(async () => {
  admin = await getTestAccessToken();
  const stored = await storeTestImage("logo");
  const object = await prisma.object.findFirstOrThrow({
    where: { bucket: { name: BRANDING_BUCKET }, objectKey: stored.objectKey },
  });
  objectId = object.id;
  objectKey = object.objectKey;
  deleteAfter = object.deleteAfter;
});

describe("a core bucket through the files API", () => {
  const uploadForm = () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(PNG)]), "x.png");
    return form;
  };
  const fakeId = randomUUID();

  it.each([
    ["upload", "PUT", "/objects/new.png", uploadForm],
    ["patch object", "PATCH", `/objects/by-id/:id`, () => ({ tags: ["x"] })],
    [
      "set object expiry",
      "PATCH",
      `/objects/by-id/:id`,
      () => ({ deleteAfter: new Date(Date.now() + 86_400_000).toISOString() }),
    ],
    ["delete object", "DELETE", `/objects/by-id/:id`, () => undefined],
    ["bulk delete", "POST", "/objects/bulk-delete", () => ({ prefix: "a" })],
    [
      "purge versions",
      "POST",
      "/objects/purge-non-current-versions",
      () => ({}),
    ],
    [
      "restore version",
      "POST",
      `/objects/by-id/:id/versions/${fakeId}/restore`,
      () => undefined,
    ],
    [
      "delete version",
      "DELETE",
      `/objects/by-id/:id/versions/${fakeId}`,
      () => undefined,
    ],
    [
      "presign a write",
      "POST",
      `/objects/by-id/:id/presign`,
      () => ({ operation: "write" }),
    ],
    [
      "initiate multipart",
      "POST",
      "/multipart",
      () => ({ objectKey: "big.bin", contentType: "image/png" }),
    ],
    ["upload part", "PUT", `/multipart/${fakeId}/parts/1`, () => undefined],
    [
      "complete multipart",
      "POST",
      `/multipart/${fakeId}/complete`,
      () => ({ parts: [{ partNumber: 1, etag: "0".repeat(32) }] }),
    ],
    ["abort multipart", "DELETE", `/multipart/${fakeId}`, () => undefined],
    ["update bucket", "PUT", "", () => ({ autoThumbnails: true })],
    ["delete bucket", "DELETE", "", () => undefined],
    [
      "set lifecycle",
      "PUT",
      "/lifecycle",
      () => ({ expireObjectsAfterDays: 30 }),
    ],
    ["delete lifecycle", "DELETE", "/lifecycle", () => undefined],
    [
      "grant access",
      "POST",
      "/permissions",
      () => ({ userId: "00000000-0000-7001-0000-000000000001", canRead: true }),
    ],
    [
      "transfer owner",
      "PUT",
      "/owner",
      () => ({ userId: "00000000-0000-7001-0000-000000000001" }),
    ],
    ["create share", "POST", "/shares", () => ({ kind: "OBJECT", objectId })],
  ])("refuses %s with 409", async (_label, method, path, body) => {
    const res = await call(method, path.replace(":id", objectId), body());
    expect(res.status, JSON.stringify(res.data)).toBe(409);
    expect(res.data?.error).toBe("bucket_managed_by_core");
  });

  it.each([
    ["update bucket", "PUT", "", { policy: "public" }],
    [
      "grant access",
      "POST",
      "/permissions",
      { userId: "00000000-0000-7001-0000-000000000001", canRead: true },
    ],
  ])(
    "refuses %s on the profile-photo bucket",
    async (_label, method, path, body) => {
      const res = await call(method, path, body, PHOTOS);
      expect(res.status, JSON.stringify(res.data)).toBe(409);
      expect(res.data?.error).toBe("bucket_managed_by_core");
    }
  );

  // Shares and grants can't be made through the API on a core bucket; these
  // stand for ones made before it became read-only.
  const seedShare = async () => {
    const bucket = await prisma.bucket.findFirstOrThrow({
      where: { name: BRANDING_BUCKET, deletedAt: null },
    });
    return await prisma.share.create({
      data: {
        token: randomBytes(24).toString("base64url"),
        bucketId: bucket.id,
        kind: "OBJECT",
        objectId,
        createdByUserId: SYSTEM_USER_ID,
      },
    });
  };

  it("refuses editing a share with 409", async () => {
    const share = await seedShare();
    try {
      const res = await call("PATCH", `/shares/by-id/${share.id}`, {
        note: "x",
      });
      expect(res.status, JSON.stringify(res.data)).toBe(409);
      expect(res.data?.error).toBe("bucket_managed_by_core");
    } finally {
      await prisma.share.delete({ where: { id: share.id } });
    }
  });

  it("revokes a share", async () => {
    const share = await seedShare();
    try {
      const res = await call("DELETE", `/shares/by-id/${share.id}`);
      expect(res.status).toBe(204);
      const revoked = await prisma.share.findUniqueOrThrow({
        where: { id: share.id },
      });
      expect(revoked.revokedAt).not.toBeNull();
    } finally {
      await prisma.share.delete({ where: { id: share.id } });
    }
  });

  it("revokes a grant", async () => {
    const user = await createTestUser();
    const bucket = await prisma.bucket.findFirstOrThrow({
      where: { name: PHOTOS, deletedAt: null },
    });
    await prisma.bucketPermission.create({
      data: {
        bucketId: bucket.id,
        userId: user.id,
        canRead: true,
        grantedBy: SYSTEM_USER_ID,
      },
    });
    const res = await call(
      "DELETE",
      `/permissions/${user.id}`,
      undefined,
      PHOTOS
    );
    expect(res.status).toBe(204);
    const grant = await prisma.bucketPermission.findUniqueOrThrow({
      where: { bucketId_userId: { bucketId: bucket.id, userId: user.id } },
    });
    expect(grant.revokedAt).not.toBeNull();
  });

  it("refuses an upload through a signed write URL", async () => {
    const { url } = presignSign({
      bucket: BRANDING_BUCKET,
      id: objectId,
      operation: "write",
      expiresInSeconds: 60,
    });
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array(PNG),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "bucket_managed_by_core"
    );
  });

  it("left the object as it was", async () => {
    const object = await prisma.object.findUniqueOrThrow({
      where: { id: objectId },
    });
    expect(object.deletedAt).toBeNull();
    expect(object.objectKey).toBe(objectKey);
    expect(object.deleteAfter).toEqual(deleteAfter);
    expect(
      await prisma.share.count({ where: { objectId } }),
      "no share was created"
    ).toBe(0);
  });

  it("still serves reads", async () => {
    expect((await call("GET", "")).status).toBe(200);
    expect((await call("GET", "/objects")).status).toBe(200);
    expect((await call("GET", `/objects/by-id/${objectId}`)).status).toBe(200);
    expect((await call("GET", `/objects/${objectKey}`)).status).toBe(200);
    expect((await call("GET", "/permissions")).status).toBe(200);
    expect((await call("GET", "/shares")).status).toBe(200);
    const presign = await call("POST", `/objects/by-id/${objectId}/presign`, {
      operation: "read",
    });
    expect(presign.status).toBe(200);
    const download = await fetch(presign.data?.url as string);
    expect(download.status).toBe(200);
  });

  it("reports no write or delete access in my-permissions", async () => {
    const res = await call("GET", "/my-permissions");
    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      canRead: true,
      canWrite: false,
      canDelete: false,
    });
  });

  it("answers 403 before 409 for a caller without access", async () => {
    const token = await getTestPrincipalToken({
      userId: randomUUID(),
      permissions: ["file-service.objects.delete"],
    });
    const res = await fetch(
      `${BASE_URL}/buckets/${BRANDING_BUCKET}/objects/by-id/${objectId}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
    );
    expect(res.status).toBe(403);
  });
});

describe("core's own writers", () => {
  it("still store a profile photo", async () => {
    const client = await createTestClient();
    const user = await createTestUser();
    const token = await getAccessTokenForUser(user, client);
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(PNG)], { type: "image/png" }),
      "me.png"
    );
    const res = await fetch(`${CORE_URL}/v1/account/photo`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    expect(res.status).toBe(201);
    const live = await prisma.object.count({
      where: {
        bucket: { name: PHOTOS },
        objectKey: { startsWith: `users/${user.id}/` },
        deletedAt: null,
      },
    });
    expect(live).toBe(1);
  });

  it("still store a branding image", async () => {
    const { token } = await brandingPrincipal([
      "branding.admin",
      "branding.write",
    ]);
    const form = new FormData();
    form.append("slot", "logo");
    form.append(
      "file",
      new Blob([new Uint8Array(Buffer.concat([PNG, randomUUIDBytes()]))]),
      "logo.png"
    );
    const res = await fetch(`${CORE_URL}/v1/admin/branding/assets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    expect(res.status).toBe(201);
  });
});

const randomUUIDBytes = () =>
  Buffer.from(randomUUID().replace(/-/g, ""), "hex");
