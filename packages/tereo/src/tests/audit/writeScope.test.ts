import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { getTestPrincipalToken } from "../utils/principals.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  cleanupTestEntities,
  generateUniqueId,
} from "./utils/test-helpers.js";

const ORG_1 = "00000000-0000-7002-8000-000000000001";
const ORG_2 = "00000000-0000-7002-8000-000000000002";
const USER_1 = "00000000-0000-7001-8000-000000000001";

const auth = (token: string) => ({
  headers: { Authorization: `Bearer ${token}` },
  validateStatus: () => true,
});

describe("Audit write organization scope", () => {
  const runId = generateUniqueId();
  const source = `test-write-scope-${runId}`;

  let org1Writer: string;
  let noOrgPersonWriter: string;
  let noOrgServiceWriter: string;
  let org1Admin: string;
  let rootAdmin: string;

  const entry = (organizationId: string | null | undefined) => ({
    source,
    ...(organizationId !== undefined && { organizationId }),
    userId: USER_1,
    userEmail: `test-write-scope-${runId}@example.com`,
    action: "CREATE",
    entityType: "WriteScope",
    entityId: `ws-${randomUUID()}`,
  });

  const writeOne = (token: string, organizationId: string | null | undefined) =>
    axios.post(`${BASE_URL}/entries`, entry(organizationId), auth(token));

  const writeBatch = (
    token: string,
    organizationIds: (string | null | undefined)[]
  ) =>
    axios.post(
      `${BASE_URL}/entries/batch`,
      { entries: organizationIds.map(entry) },
      auth(token)
    );

  const countWritten = () => prisma.auditLogEntry.count({ where: { source } });

  beforeAll(async () => {
    org1Writer = await getTestPrincipalToken({
      organizationId: ORG_1,
      permissions: ["audit-logs.write"],
    });
    noOrgPersonWriter = await getTestPrincipalToken({
      organizationId: null,
      permissions: ["audit-logs.write"],
    });

    // An app service's client: a service-account user, no organization.
    const serviceUserId = randomUUID();
    await prisma.user.create({
      data: {
        id: serviceUserId,
        email: `test-write-scope-svc-${runId}@services.example.com`,
        name: "Write scope service",
        passwordHash: "!",
        userType: "service_account",
      },
    });
    noOrgServiceWriter = await getTestPrincipalToken({
      userId: serviceUserId,
      organizationId: null,
      permissions: ["audit-logs.write"],
    });

    org1Admin = await getTestAccessToken(USER_1, ORG_1);
    rootAdmin = await getTestPrincipalToken({
      organizationId: null,
      permissions: ["admin"],
    });
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  describe("a writer whose token names an organization", () => {
    it("writes for its own organization", async () => {
      const res = await writeOne(org1Writer, ORG_1);
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      expect(res.data.organizationId).toBe(ORG_1);
    });

    it("gets 403 for another organization", async () => {
      const before = await countWritten();
      const res = await writeOne(org1Writer, ORG_2);
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(res.data.error).toBe("forbidden");
      expect(await countWritten()).toBe(before);
    });

    it("gets 403 for a system-wide entry, given as null or left out", async () => {
      expect((await writeOne(org1Writer, null)).status).toBe(
        HTTP_STATUS.FORBIDDEN
      );
      expect((await writeOne(org1Writer, undefined)).status).toBe(
        HTTP_STATUS.FORBIDDEN
      );
    });

    it("gets 403 before an unknown organization's 400", async () => {
      const res = await writeOne(org1Writer, randomUUID());
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it("writes a batch for its own organization", async () => {
      const res = await writeBatch(org1Writer, [ORG_1, ORG_1]);
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      expect(res.data.created).toBe(2);
    });

    it("has a batch with one other organization refused whole", async () => {
      const before = await countWritten();
      const res = await writeBatch(org1Writer, [ORG_1, ORG_2, ORG_1]);
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(await countWritten()).toBe(before);

      const withNull = await writeBatch(org1Writer, [ORG_1, null]);
      expect(withNull.status).toBe(HTTP_STATUS.FORBIDDEN);
      expect(await countWritten()).toBe(before);
    });
  });

  describe("a token without an organization", () => {
    it("refuses a person's token outright", async () => {
      expect((await writeOne(noOrgPersonWriter, ORG_1)).status).toBe(
        HTTP_STATUS.FORBIDDEN
      );
      expect((await writeOne(noOrgPersonWriter, null)).status).toBe(
        HTTP_STATUS.FORBIDDEN
      );
      expect((await writeBatch(noOrgPersonWriter, [ORG_1])).status).toBe(
        HTTP_STATUS.FORBIDDEN
      );
    });

    it("lets a service account write any organization, or none", async () => {
      expect((await writeOne(noOrgServiceWriter, ORG_1)).status).toBe(
        HTTP_STATUS.CREATED
      );
      expect((await writeOne(noOrgServiceWriter, ORG_2)).status).toBe(
        HTTP_STATUS.CREATED
      );
      expect((await writeOne(noOrgServiceWriter, null)).status).toBe(
        HTTP_STATUS.CREATED
      );
      const batch = await writeBatch(noOrgServiceWriter, [ORG_1, ORG_2, null]);
      expect(batch.status).toBe(HTTP_STATUS.CREATED);
      expect(batch.data.created).toBe(3);
    });
  });

  describe("audit-logs.admin", () => {
    it("writes for another organization and system-wide", async () => {
      expect((await writeOne(org1Admin, ORG_2)).status).toBe(
        HTTP_STATUS.CREATED
      );
      expect((await writeOne(org1Admin, null)).status).toBe(
        HTTP_STATUS.CREATED
      );
      const batch = await writeBatch(org1Admin, [ORG_1, ORG_2, null]);
      expect(batch.status).toBe(HTTP_STATUS.CREATED);
    });

    it("is covered by the root admin permission", async () => {
      const batch = await writeBatch(rootAdmin, [ORG_1, ORG_2, null]);
      expect(batch.status).toBe(HTTP_STATUS.CREATED);
      expect(batch.data.created).toBe(3);
    });
  });
});
