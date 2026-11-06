// @module-tag int
// @module-tag files
import { getAccessTokenForUser } from "../../support/auth/login.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestClient } from "../../support/auth/clients.js";
import { createTestGuest } from "../../support/auth/guests.js";
import { prisma } from "../../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  ensureTestOrganization,
  getTestPrincipalToken,
} from "../../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  grantTestPermission,
  uploadTestObject,
} from "../../support/files.js";

const ORG = "guest-files-org";

const as = (token: string) => ({
  headers: { Authorization: `Bearer ${token}` },
  validateStatus: () => true,
});

describe("a guest's file access", () => {
  let guestToken: string;
  let granted: string;
  let other: string;
  let objectId: string;

  beforeAll(async () => {
    const organizationId = await ensureTestOrganization(ORG);
    const permissions = await prisma.permission.findMany({
      where: {
        name: {
          in: ["file-service.objects.read", "file-service.objects.write"],
        },
      },
      select: { id: true },
    });
    expect(permissions).toHaveLength(2);
    const role = await prisma.role.create({
      data: {
        name: `test-guest-files-${randomUUID()}`,
        displayName: "Guest files",
        guestAssignable: true,
        rolePermissions: {
          create: permissions.map((p) => ({ permissionId: p.id })),
        },
      },
    });
    const { user, plainPassword } = await createTestGuest({
      organizationId,
      roleIds: [role.id],
    });
    guestToken = await getAccessTokenForUser(
      { id: user.id, email: user.email, plainPassword },
      await createTestClient()
    );

    const creator = await getTestPrincipalToken({
      organizationId: ORG,
      permissions: ["file-service.admin"],
    });
    granted = (await createTestBucket(creator)).name;
    other = (await createTestBucket(creator)).name;
    objectId = (
      await uploadTestObject(
        creator,
        granted,
        "shared.txt",
        createTestFile("for the guest")
      )
    ).id;
    await uploadTestObject(
      creator,
      other,
      "private.txt",
      createTestFile("not for the guest")
    );
    await grantTestPermission(creator, granted, user.id, {
      canRead: true,
      canWrite: true,
    });
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("reads and writes objects in the granted bucket", async () => {
    const read = await axios.get(
      `${BASE_URL}/buckets/${granted}/objects/shared.txt`,
      as(guestToken)
    );
    expect(read.status).toBe(HTTP_STATUS.OK);
    expect(read.data).toBe("for the guest");

    const written = await uploadTestObject(
      guestToken,
      granted,
      "from-guest.txt",
      createTestFile("guest upload")
    );
    expect(written.key).toBe("from-guest.txt");
  });

  it("is refused another bucket", async () => {
    const read = await axios.get(
      `${BASE_URL}/buckets/${other}/objects/private.txt`,
      as(guestToken)
    );
    expect(read.status).toBe(HTTP_STATUS.FORBIDDEN);
    await expect(
      uploadTestObject(guestToken, other, "x.txt", createTestFile("no"))
    ).rejects.toThrow(/Failed to upload test object: 403/);
  });

  it("cannot create a share", async () => {
    const res = await axios.post(
      `${BASE_URL}/buckets/${granted}/shares`,
      { kind: "OBJECT", objectId },
      as(guestToken)
    );
    expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
  });
});
