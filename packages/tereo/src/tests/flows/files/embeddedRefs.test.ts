// @module-tag int
// @module-tag files
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  ensureTestMembership,
  ensureTestUser,
  getTestPrincipalToken,
  testOrgId,
} from "../../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  uploadTestObject,
} from "../../support/files.js";

describe("embedded user refs in file responses", () => {
  const ORG = "files-embedded-refs-org";

  const as = (token?: string) => ({
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    validateStatus: () => true,
  });

  const userRef = (id: string) => ({
    id,
    email: `test-user-${id}@example.com`,
    name: `Test User ${id}`,
  });
  const ownerId = randomUUID();
  let ownerToken: string;
  let orgRef: { id: string; name: string; slug: string };

  beforeAll(async () => {
    ownerToken = await getTestPrincipalToken({
      userId: ownerId,
      organizationId: ORG,
      permissions: ["file-service.admin"],
    });
    await ensureTestMembership(ownerId, ORG);
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: testOrgId(ORG) },
    });
    orgRef = { id: org.id, name: org.name, slug: org.slug };
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  const versionedBucket = async (policy: "public" | "private" = "private") => {
    const bucket = await createTestBucket(ownerToken, { policy });
    const put = await axios.put(
      `${BASE_URL}/buckets/${bucket.name}`,
      { versioningEnabled: true },
      as(ownerToken)
    );
    expect(put.status).toBe(HTTP_STATUS.OK);
    return bucket as { id: number; name: string };
  };

  it("buckets: the creator, organization and service on create, read, list and update", async () => {
    const bucket = await createTestBucket(ownerToken);
    expect(bucket.creator).toEqual(userRef(ownerId));
    expect(bucket.organizationId).toBe(orgRef.id);
    expect(bucket.organization).toEqual(orgRef);
    expect(bucket.service).toBeNull();

    const got = await axios.get(
      `${BASE_URL}/buckets/${bucket.name}`,
      as(ownerToken)
    );
    expect(got.data).toMatchObject({
      creator: userRef(ownerId),
      organization: orgRef,
      service: null,
    });

    const updated = await axios.put(
      `${BASE_URL}/buckets/${bucket.name}`,
      { description: "renamed" },
      as(ownerToken)
    );
    expect(updated.status).toBe(HTTP_STATUS.OK);
    expect(updated.data).toMatchObject({
      creator: userRef(ownerId),
      organization: orgRef,
    });

    const listed = await axios.get(
      `${BASE_URL}/buckets?filter[name]=${bucket.name}&filter[name_op]=equals`,
      as(ownerToken)
    );
    expect(listed.status).toBe(HTTP_STATUS.OK);
    expect(listed.data.data).toHaveLength(1);
    expect(listed.data.data[0]).toMatchObject({
      creator: userRef(ownerId),
      organization: orgRef,
    });
  });

  it("permissions: the grant answers with the grantee and granter, as the list does", async () => {
    const bucket = await createTestBucket(ownerToken);
    const granteeId = await ensureTestUser(randomUUID());
    await ensureTestMembership(granteeId, ORG);

    const granted = await axios.post(
      `${BASE_URL}/buckets/${bucket.name}/permissions`,
      { userId: granteeId, canRead: true },
      as(ownerToken)
    );
    expect(granted.status).toBe(HTTP_STATUS.CREATED);
    expect(granted.data).toMatchObject({
      userId: granteeId,
      userEmail: userRef(granteeId).email,
      userName: userRef(granteeId).name,
      user: userRef(granteeId),
      grantedBy: ownerId,
      grantedByEmail: userRef(ownerId).email,
      grantedByName: userRef(ownerId).name,
      granter: userRef(ownerId),
    });

    const listed = await axios.get(
      `${BASE_URL}/buckets/${bucket.name}/permissions`,
      as(ownerToken)
    );
    const row = listed.data.data.find(
      (p: { userId: string }) => p.userId === granteeId
    );
    expect(row).toEqual(granted.data);
  });

  it("shares: the creator, and who revoked it", async () => {
    const bucket = await createTestBucket(ownerToken);
    const object = await uploadTestObject(
      ownerToken,
      bucket.name,
      "shared.txt",
      createTestFile("shared")
    );
    const created = await axios.post(
      `${BASE_URL}/buckets/${bucket.name}/shares`,
      { kind: "OBJECT", objectId: object.id },
      as(ownerToken)
    );
    expect(created.status).toBe(HTTP_STATUS.CREATED);
    expect(created.data.creator).toEqual(userRef(ownerId));
    expect(created.data.revokedByUser).toBeNull();

    const revokerId = randomUUID();
    const revoker = await getTestPrincipalToken({
      userId: revokerId,
      organizationId: ORG,
      permissions: ["file-service.admin"],
    });
    const revoked = await axios.delete(
      `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${created.data.id}`,
      as(revoker)
    );
    expect(revoked.status).toBe(HTTP_STATUS.NO_CONTENT);

    const got = await axios.get(
      `${BASE_URL}/buckets/${bucket.name}/shares/by-id/${created.data.id}`,
      as(ownerToken)
    );
    expect(got.data).toMatchObject({
      createdByUserId: ownerId,
      creator: userRef(ownerId),
      revokedByUserId: revokerId,
      revokedByUser: userRef(revokerId),
    });
    const listed = await axios.get(
      `${BASE_URL}/buckets/${bucket.name}/shares`,
      as(ownerToken)
    );
    expect(listed.data.data[0].revokedByUser).toEqual(userRef(revokerId));
  });

  it("versions: the detail names the writer as the list does, for readers only", async () => {
    const bucket = await versionedBucket("public");
    const object = await uploadTestObject(
      ownerToken,
      bucket.name,
      "doc.txt",
      createTestFile("v1")
    );
    const base = `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${object.id}/versions`;

    const list = await axios.get(base, as(ownerToken));
    const [listed] = list.data.data;
    const detail = await axios.get(
      `${base}/${listed.versionId}`,
      as(ownerToken)
    );
    expect(detail.status).toBe(HTTP_STATUS.OK);
    const named = {
      createdBy: ownerId,
      createdByEmail: userRef(ownerId).email,
      createdByName: userRef(ownerId).name,
      creator: userRef(ownerId),
    };
    expect(listed).toMatchObject(named);
    expect(detail.data).toEqual(listed);

    // Served only because the bucket is public: anonymous, or another
    // organization's caller.
    const unnamed = {
      createdBy: null,
      createdByEmail: null,
      createdByName: null,
      creator: null,
    };
    const outsider = await getTestPrincipalToken({
      userId: randomUUID(),
      organizationId: `${ORG}-other`,
      permissions: ["file-service.objects.read"],
    });
    for (const token of [undefined, outsider]) {
      const anonList = await axios.get(base, as(token));
      expect(anonList.status).toBe(HTTP_STATUS.OK);
      expect(anonList.data.data[0]).toMatchObject(unnamed);
      const anonDetail = await axios.get(
        `${base}/${listed.versionId}`,
        as(token)
      );
      expect(anonDetail.status).toBe(HTTP_STATUS.OK);
      expect(anonDetail.data).toMatchObject(unnamed);
    }
  });

  it("deleted objects: who deleted each, for readers only", async () => {
    const bucket = await versionedBucket("public");
    const object = await uploadTestObject(
      ownerToken,
      bucket.name,
      "gone.txt",
      createTestFile("gone")
    );
    const deleted = await axios.delete(
      `${BASE_URL}/buckets/${bucket.name}/objects/by-id/${object.id}`,
      as(ownerToken)
    );
    expect(deleted.status).toBe(HTTP_STATUS.NO_CONTENT);

    const url = `${BASE_URL}/buckets/${bucket.name}/objects?deleted=true`;
    const own = await axios.get(url, as(ownerToken));
    expect(own.data.data).toEqual([
      expect.objectContaining({
        id: object.id,
        deletedBy: ownerId,
        deletedByUser: userRef(ownerId),
      }),
    ]);

    // A public bucket's history is for callers with a grant.
    const anon = await axios.get(url, as());
    expect(anon.status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });
});
