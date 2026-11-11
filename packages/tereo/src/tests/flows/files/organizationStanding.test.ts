// @module-tag int
// @module-tag files
// @module-tag security
import { getTestPrincipalToken } from "../../support/principals.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestBucket,
  createTestFile,
  uploadTestObject,
  uploadTestObjectAndGetId,
} from "../../support/files.js";

describe("an inactive organization's buckets", () => {
  let organizationId: string;
  let shareUrl: string;
  let signedUrl: string;
  let publicObjectUrl: string;
  let publicListUrl: string;

  const anon = (url: string) =>
    axios.get(url, { maxRedirects: 0, validateStatus: () => true });

  const setStanding = (data: { isActive: boolean; archivedAt: Date | null }) =>
    prisma.organization.update({ where: { id: organizationId }, data });

  const statuses = async () => ({
    share: (await anon(shareUrl)).status,
    signed: (await anon(signedUrl)).status,
    publicObject: (await anon(publicObjectUrl)).status,
    publicList: (await anon(publicListUrl)).status,
  });

  const serving = {
    share: 302,
    signed: HTTP_STATUS.OK,
    publicObject: HTTP_STATUS.OK,
    publicList: HTTP_STATUS.OK,
  };
  const hidden = {
    share: HTTP_STATUS.NOT_FOUND,
    signed: HTTP_STATUS.NOT_FOUND,
    publicObject: HTTP_STATUS.NOT_FOUND,
    publicList: HTTP_STATUS.NOT_FOUND,
  };

  beforeAll(async () => {
    const token = await getTestPrincipalToken({
      permissions: ["file-service.admin"],
      organizationId: "files-organization-standing",
    });
    const shared = await createTestBucket(token, { policy: "private" });
    organizationId = (
      await prisma.bucket.findUniqueOrThrow({ where: { id: shared.id } })
    ).organizationId!;
    expect(organizationId).toBeTruthy();

    const objectId = await uploadTestObjectAndGetId(
      token,
      shared.name,
      "shared.txt",
      createTestFile("shared", "shared.txt", "text/plain")
    );
    const share = await axios.post(
      `${BASE_URL}/buckets/${shared.name}/shares`,
      { kind: "OBJECT", objectId },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    shareUrl = share.data.url;
    signedUrl = (await anon(shareUrl)).headers["location"];

    const open = await createTestBucket(token, { policy: "public" });
    await uploadTestObject(
      token,
      open.name,
      "open.txt",
      createTestFile("open", "open.txt", "text/plain")
    );
    publicListUrl = `${BASE_URL}/buckets/${open.name}/objects`;
    publicObjectUrl = `${publicListUrl}/open.txt`;
  });

  afterAll(async () => {
    await setStanding({ isActive: true, archivedAt: null });
    await cleanupTestEntities();
  });

  it("serves share links, their signed URLs and public reads while the organization is active", async () => {
    expect(await statuses()).toEqual(serving);
  });

  it("answers 404 while the organization is deactivated, and serves again once it is reactivated", async () => {
    await setStanding({ isActive: false, archivedAt: null });
    expect(await statuses()).toEqual(hidden);

    await setStanding({ isActive: true, archivedAt: null });
    expect(await statuses()).toEqual(serving);
    expect(
      await prisma.share.count({
        where: { bucket: { organizationId }, revokedAt: { not: null } },
      })
    ).toBe(0);
  });

  it("answers 404 while the organization is archived", async () => {
    await setStanding({ isActive: false, archivedAt: new Date() });
    expect(await statuses()).toEqual(hidden);

    await setStanding({ isActive: true, archivedAt: null });
    expect(await statuses()).toEqual(serving);
  });
});
