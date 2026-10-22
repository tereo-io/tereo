// @module-tag int
// @module-tag audit
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createAppServiceAccount } from "../../../../support/testService.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { CORE_URL } from "../../../../support/coreUrl.js";
import { randomUUID } from "crypto";
import axios from "axios";
import {
  provisionService,
  removeServices,
  type ProvisionedService,
} from "../../../../support/provisioning.js";
import {
  cleanup as cleanupIntegrations,
  createIntegration,
  grant,
  integrationToken,
} from "../../../../support/integrations.js";
import {
  ensureTestUser,
  getTestPrincipalToken,
  ensureTestOrganization,
} from "../../../../support/principals.js";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  getTestOrgId,
  cleanupTestEntities,
  generateUniqueId,
} from "../../../../support/audit.js";

describe("POST /v1/audit/entries", () => {
  describe("Audit Log Entries", () => {
    const organizationId = getTestOrgId();

    afterEach(async () => {
      await cleanupTestEntities();
    });

    describe("POST /v1/entries", () => {
      it("should return 403 with read-only permissions", async () => {
        const readOnlyToken = await getTestPrincipalToken({
          organizationId: "00000000-0000-7002-8000-000000000001",
          permissions: ["audit-logs.read"],
        });

        const response = await axios.post(
          `${BASE_URL}/entries`,
          {
            source: "test-service",
            userId: "00000000-0000-7001-8000-000000000001",
            action: "CREATE",
            entityType: "Order",
            entityId: "order-1",
          },
          {
            headers: { Authorization: `Bearer ${readOnlyToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
      });
    });

    describe("Permission hierarchy", () => {
      it("should allow delete permission to write entries", async () => {
        const deleteToken = await getTestPrincipalToken({
          organizationId: "00000000-0000-7002-8000-000000000001",
          permissions: ["audit-logs.delete"],
        });
        const uniqueId = generateUniqueId();

        const response = await axios.post(
          `${BASE_URL}/entries`,
          {
            source: "test-service",
            organizationId,
            userId: "00000000-0000-7001-8000-000000000001",
            action: "CREATE",
            entityType: "Order",
            entityId: `order-${uniqueId}`,
          },
          {
            headers: { Authorization: `Bearer ${deleteToken}` },
            validateStatus: () => true,
          }
        );

        expect(response.status).toBe(HTTP_STATUS.CREATED);
      });
    });
  });

  describe("Audit reads scoped to the calling service", () => {
    // A service reads the audit entries it wrote, under its own slug, across every
    // organization, with only audit-logs.read (audit_reader) or audit-logs.write
    // (audit_writer), and writes entries only under its own slug.

    const api = axios.create({ validateStatus: () => true });
    const auth = (token: string) => ({
      headers: { Authorization: `Bearer ${token}` },
    });

    const clientToken = async (service: ProvisionedService) => {
      const { clientId, clientSecret } = service.credentials;
      const response = await fetch(`${CORE_URL}/oauth/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { access_token: string }).access_token;
    };

    const runId = generateUniqueId();
    const entityType = `SvcScope${runId}`;
    const userEmail = `test-svc-scope-${runId}@example.com`;
    const slugs: string[] = [];

    let reader: ProvisionedService;
    let writer: ProvisionedService;
    let writerToken: string;
    let org1: string;
    let userId: string;

    beforeAll(async () => {
      reader = await provisionService({ access: { roles: ["audit_reader"] } });
      writer = await provisionService({ access: { roles: ["audit_writer"] } });
      slugs.push(reader.slug, writer.slug);
      writerToken = await clientToken(writer);
      org1 = await ensureTestOrganization(`svc-scope-1-${runId}`);
      userId = await ensureTestUser(
        `00000000-0000-7001-8000-${runId.slice(0, 12).padStart(12, "0")}`
      );
    });

    afterAll(async () => {
      await prisma.auditLogEntry.deleteMany({ where: { userEmail } });
      await removeServices(slugs);
    });

    describe("writes", () => {
      const entry = (source: string) => ({
        source,
        organizationId: org1,
        userId,
        userEmail,
        action: "CREATE",
        entityType,
        entityId: `write-${runId}`,
      });

      it("refuses an entry under another source", async () => {
        const response = await api.post(
          `${BASE_URL}/entries`,
          entry(reader.slug),
          auth(writerToken)
        );
        expect(response.status).toBe(HTTP_STATUS.UNPROCESSABLE_ENTITY);
        expect(response.data.error).toBe("source_mismatch");
        expect(response.data.error_description).toContain(`"${writer.slug}"`);
      });

      it("refuses a batch with one entry under another source", async () => {
        const response = await api.post(
          `${BASE_URL}/entries/batch`,
          { entries: [entry(writer.slug), entry("tereo")] },
          auth(writerToken)
        );
        expect(response.status).toBe(HTTP_STATUS.UNPROCESSABLE_ENTITY);
        expect(response.data.error).toBe("source_mismatch");
        expect(
          await prisma.auditLogEntry.count({
            where: { entityId: `write-${runId}` },
          })
        ).toBe(0);
      });

      it("writes entries under its own slug", async () => {
        const one = await api.post(
          `${BASE_URL}/entries`,
          entry(writer.slug),
          auth(writerToken)
        );
        expect(one.status).toBe(HTTP_STATUS.CREATED);
        const batch = await api.post(
          `${BASE_URL}/entries/batch`,
          { entries: [entry(writer.slug)] },
          auth(writerToken)
        );
        expect(batch.status).toBe(HTTP_STATUS.CREATED);
      });
    });

    it('refuses a service slugged "tereo", the source of core\'s entries', async () => {
      const adminToken = await getTestPrincipalToken({
        permissions: ["services.read", "services.write"],
      });
      const response = await api.post(
        `${CORE_URL}/v1/admin/services`,
        { name: "Tereo", slug: "tereo", namespace: `tereo-ns-${runId}` },
        auth(adminToken)
      );
      expect(response.status).toBe(HTTP_STATUS.CONFLICT);
      expect(response.data.error_description).toContain("reserved");
    });
  });

  describe("Audit write organization scope", () => {
    const ORG_1 = "00000000-0000-7002-8000-000000000001";
    const ORG_2 = "00000000-0000-7002-8000-000000000002";
    const USER_1 = "00000000-0000-7001-8000-000000000001";

    const auth = (token: string) => ({
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });

    const runId = generateUniqueId();
    const source = `test-write-scope-${runId}`;

    let org1Writer: string;
    let noOrgPersonWriter: string;
    let noOrgServiceWriter: string;
    let serviceSlug: string;
    let noOrgAccountWriter: string;
    let noOrgIntegrationWriter: string;
    let org1Admin: string;
    let rootAdmin: string;

    const entry = (
      organizationId: string | null | undefined,
      entrySource = source
    ) => ({
      source: entrySource,
      ...(organizationId !== undefined && { organizationId }),
      userId: USER_1,
      userEmail: `test-write-scope-${runId}@example.com`,
      action: "CREATE",
      entityType: "WriteScope",
      entityId: `ws-${randomUUID()}`,
    });

    const writeOne = (
      token: string,
      organizationId: string | null | undefined,
      entrySource?: string
    ) =>
      axios.post(
        `${BASE_URL}/entries`,
        entry(organizationId, entrySource),
        auth(token)
      );

    const writeBatch = (
      token: string,
      organizationIds: (string | null | undefined)[],
      entrySource?: string
    ) =>
      axios.post(
        `${BASE_URL}/entries/batch`,
        { entries: organizationIds.map((id) => entry(id, entrySource)) },
        auth(token)
      );

    const countWritten = () =>
      prisma.auditLogEntry.count({ where: { source } });

    beforeAll(async () => {
      org1Writer = await getTestPrincipalToken({
        organizationId: ORG_1,
        permissions: ["audit-logs.write"],
      });
      noOrgPersonWriter = await getTestPrincipalToken({
        organizationId: null,
        permissions: ["audit-logs.write"],
      });

      const service = await createAppServiceAccount("write-scope-svc");
      serviceSlug = service.slug;
      noOrgServiceWriter = await getTestPrincipalToken({
        userId: service.userId,
        organizationId: null,
        permissions: ["audit-logs.write"],
      });

      // A service account that is no app service's.
      const accountUserId = randomUUID();
      await prisma.user.create({
        data: {
          id: accountUserId,
          email: `test-write-scope-acct-${runId}@services.example.com`,
          name: "Write scope account",
          passwordHash: "!",
          userType: "service_account",
        },
      });
      noOrgAccountWriter = await getTestPrincipalToken({
        userId: accountUserId,
        organizationId: null,
        permissions: ["audit-logs.write"],
      });

      const integration = await createIntegration(
        await getTestPrincipalToken({
          permissions: ["integrations.read", "integrations.write"],
        })
      );
      await grant(integration, ["audit-logs.write"]);
      noOrgIntegrationWriter = await integrationToken(integration);

      org1Admin = await getTestAccessToken(USER_1, ORG_1);
      rootAdmin = await getTestPrincipalToken({
        organizationId: null,
        permissions: ["admin"],
      });
    });

    afterAll(async () => {
      await cleanupTestEntities();
      await cleanupIntegrations();
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

      it("lets an app service write any organization, or none", async () => {
        expect(
          (await writeOne(noOrgServiceWriter, ORG_1, serviceSlug)).status
        ).toBe(HTTP_STATUS.CREATED);
        expect(
          (await writeOne(noOrgServiceWriter, ORG_2, serviceSlug)).status
        ).toBe(HTTP_STATUS.CREATED);
        expect(
          (await writeOne(noOrgServiceWriter, null, serviceSlug)).status
        ).toBe(HTTP_STATUS.CREATED);
        const batch = await writeBatch(
          noOrgServiceWriter,
          [ORG_1, ORG_2, null],
          serviceSlug
        );
        expect(batch.status).toBe(HTTP_STATUS.CREATED);
        expect(batch.data.created).toBe(3);
      });

      it("refuses an integration's or another service account's token", async () => {
        for (const token of [noOrgIntegrationWriter, noOrgAccountWriter]) {
          expect((await writeOne(token, ORG_1)).status).toBe(
            HTTP_STATUS.FORBIDDEN
          );
          expect((await writeOne(token, null)).status).toBe(
            HTTP_STATUS.FORBIDDEN
          );
        }
      });
    });

    describe("reserved sources", () => {
      it("refuses core's source and a service's slug to anyone but that service", async () => {
        for (const reserved of ["tereo", "core", serviceSlug]) {
          for (const token of [org1Writer, rootAdmin]) {
            const res = await writeOne(token, ORG_1, reserved);
            expect(res.status).toBe(422);
            expect(res.data.error).toBe("source_reserved");
          }
        }
        const before = await countWritten();
        const batch = await axios.post(
          `${BASE_URL}/entries/batch`,
          { entries: [entry(ORG_1), entry(ORG_1, "tereo")] },
          auth(org1Writer)
        );
        expect(batch.status).toBe(422);
        expect(await countWritten()).toBe(before);
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
});
