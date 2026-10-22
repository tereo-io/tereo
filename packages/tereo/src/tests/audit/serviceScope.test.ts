import { BASE_URL, HTTP_STATUS, generateUniqueId } from "../support/audit.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { CORE_URL } from "../support/coreUrl.js";
import axios from "axios";
import {
  provisionService,
  removeServices,
  type ProvisionedService,
} from "../support/provisioning.js";
import {
  cleanup as cleanupIntegrations,
  createIntegration,
  grant,
  integrationToken,
} from "../support/integrations.js";
import {
  ensureTestOrganization,
  ensureTestUser,
  getTestPrincipalToken,
} from "../support/principals.js";

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

const accountOf = async (service: ProvisionedService) => {
  const row = await prisma.service.findUniqueOrThrow({
    where: { id: service.id },
    include: { client: { include: { serviceAccountUser: true } } },
  });
  return row.client!.serviceAccountUser!.id;
};

describe("Audit reads scoped to the calling service", () => {
  const runId = generateUniqueId();
  const entityType = `SvcScope${runId}`;
  const entityId = `svc-scope-${runId}`;
  const userEmail = `test-svc-scope-${runId}@example.com`;
  const slugs: string[] = [];

  let reader: ProvisionedService;
  let writer: ProvisionedService;
  let readerToken: string;
  let writerToken: string;
  let org1: string;
  let org2: string;
  let userId: string;
  const ids: Record<string, string> = {};

  const insert = async (
    key: string,
    source: string,
    writerUserId: string,
    organizationId: string | null,
    metadata: Record<string, unknown>
  ) => {
    const entry = await prisma.auditLogEntry.create({
      data: {
        source,
        organizationId,
        userId,
        userEmail,
        action: "CREATE",
        entityType,
        entityId,
        entityName: `needle-${runId}`,
        metadata: metadata as object,
        writerUserId,
      },
    });
    ids[key] = entry.id;
  };

  const list = async (token: string, params: Record<string, string> = {}) => {
    const response = await api.get(`${BASE_URL}/entries`, {
      ...auth(token),
      params: { "filter[entityType]": entityType, ...params },
    });
    return {
      status: response.status,
      ids: ((response.data?.data ?? []) as { id: string }[])
        .map((e) => e.id)
        .sort(),
    };
  };

  const idsOf = (...keys: string[]) => keys.map((k) => ids[k]).sort();

  beforeAll(async () => {
    reader = await provisionService({ access: { roles: ["audit_reader"] } });
    writer = await provisionService({ access: { roles: ["audit_writer"] } });
    slugs.push(reader.slug, writer.slug);
    readerToken = await clientToken(reader);
    writerToken = await clientToken(writer);
    org1 = await ensureTestOrganization(`svc-scope-1-${runId}`);
    org2 = await ensureTestOrganization(`svc-scope-2-${runId}`);
    userId = await ensureTestUser(
      `00000000-0000-7001-8000-${runId.slice(0, 12).padStart(12, "0")}`
    );

    const readerAccount = await accountOf(reader);
    const writerAccount = await accountOf(writer);
    await insert("own1", reader.slug, readerAccount, org1, { ownKey: "x" });
    await insert("own2", reader.slug, readerAccount, org2, { ownKey: "x" });
    await insert("ownSystem", reader.slug, readerAccount, null, {
      ownKey: "x",
    });
    // Same source, written by someone else: not the service's own.
    await insert("forged", reader.slug, userId, org1, { forgedKey: "x" });
    await insert("other", writer.slug, writerAccount, org1, {
      otherKey: "x",
    });
  });

  afterAll(async () => {
    await prisma.auditLogEntry.deleteMany({ where: { userEmail } });
    await removeServices(slugs);
    await cleanupIntegrations();
  });

  it("lists its own entries across every organization and system-wide", async () => {
    const result = await list(readerToken);
    expect(result.status).toBe(HTTP_STATUS.OK);
    expect(result.ids).toEqual(idsOf("own1", "own2", "ownSystem"));
  });

  it("narrows to one organization, or to system-wide entries", async () => {
    expect(
      (await list(readerToken, { "filter[organizationId]": org1 })).ids
    ).toEqual(idsOf("own1"));
    expect(
      (await list(readerToken, { "filter[organizationId]": "none" })).ids
    ).toEqual(idsOf("ownSystem"));
  });

  it("intersects filter[source] with its own: another source is an empty page", async () => {
    const other = await list(readerToken, { "filter[source]": writer.slug });
    expect(other.status).toBe(HTTP_STATUS.OK);
    expect(other.ids).toEqual([]);
    expect(
      (await list(readerToken, { "filter[source]": reader.slug })).ids
    ).toEqual(idsOf("own1", "own2", "ownSystem"));
  });

  it("scopes a text search", async () => {
    const result = await list(readerToken, { "filter[q]": `needle-${runId}` });
    expect(result.status).toBe(HTTP_STATUS.OK);
    expect(result.ids).toEqual(idsOf("own1", "own2", "ownSystem"));
  });

  it("reads its own entry by id, and 404s another's", async () => {
    const own = await api.get(`${BASE_URL}/entries/${ids.own2}`, {
      ...auth(readerToken),
    });
    expect(own.status).toBe(HTTP_STATUS.OK);
    expect(own.data.id).toBe(ids.own2);
    for (const key of ["other", "forged"]) {
      const response = await api.get(`${BASE_URL}/entries/${ids[key]}`, {
        ...auth(readerToken),
      });
      expect(response.status, key).toBe(HTTP_STATUS.NOT_FOUND);
    }
  });

  it("scopes an entity's history", async () => {
    const response = await api.get(
      `${BASE_URL}/entries/entity/${entityType}/${entityId}`,
      auth(readerToken)
    );
    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(
      (response.data.data as { id: string }[]).map((e) => e.id).sort()
    ).toEqual(idsOf("own1", "own2", "ownSystem"));
  });

  it("scopes facets", async () => {
    const response = await api.get(`${BASE_URL}/entries/facets`, {
      ...auth(readerToken),
    });
    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(response.data.sources).toEqual([reader.slug]);
    expect(response.data.metadataKeys).toContain("ownKey");
    expect(response.data.metadataKeys).not.toContain("otherKey");
    expect(response.data.metadataKeys).not.toContain("forgedKey");
  });

  it("lets an audit_writer service read its own entries", async () => {
    const result = await list(writerToken);
    expect(result.status).toBe(HTTP_STATUS.OK);
    expect(result.ids).toEqual(idsOf("other"));
  });

  it("refuses a service with neither role", async () => {
    const bare = await provisionService();
    slugs.push(bare.slug);
    const result = await list(await clientToken(bare));
    expect(result.status).toBe(HTTP_STATUS.FORBIDDEN);
  });

  it("still refuses an integration without an organization", async () => {
    const adminToken = await getTestPrincipalToken({
      permissions: ["integrations.read", "integrations.write"],
    });
    const integration = await createIntegration(adminToken);
    await grant(integration, ["audit-logs.read"]);
    const result = await list(await integrationToken(integration));
    expect(result.status).toBe(HTTP_STATUS.FORBIDDEN);
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
