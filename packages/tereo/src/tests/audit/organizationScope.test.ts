import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { getTestPrincipalToken } from "../utils/principals.js";
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
const USER_2 = "00000000-0000-7001-8000-000000000002";

const auth = (token: string) => ({
  headers: { Authorization: `Bearer ${token}` },
  validateStatus: () => true,
});

describe("Audit organization scope", () => {
  const runId = generateUniqueId();
  const source = `test-scope-${runId}`;
  const entityType = `ScopeEntity${runId}`;
  const entityId = `scope-${runId}`;
  const ids: { org1: string; org2: string; systemWide: string } = {
    org1: "",
    org2: "",
    systemWide: "",
  };

  let org1Admin: string;
  let org1Reader: string;
  let rootAdmin: string;

  beforeAll(async () => {
    org1Admin = await getTestAccessToken(USER_1, ORG_1);
    const org2Admin = await getTestAccessToken(USER_2, ORG_2);
    org1Reader = await getTestPrincipalToken({
      organizationId: ORG_1,
      permissions: ["audit-logs.read"],
    });
    rootAdmin = await getTestPrincipalToken({
      organizationId: null,
      permissions: ["admin"],
    });

    const write = async (
      token: string,
      organizationId: string | null,
      userId: string
    ) => {
      const res = await axios.post(
        `${BASE_URL}/entries`,
        {
          source,
          organizationId,
          userId,
          userEmail: `test-scope-${runId}@example.com`,
          action: "UPDATE",
          entityType,
          entityId,
        },
        auth(token)
      );
      expect(res.status).toBe(HTTP_STATUS.CREATED);
      return res.data.id as string;
    };

    ids.org1 = await write(org1Admin, ORG_1, USER_1);
    ids.org2 = await write(org2Admin, ORG_2, USER_2);
    ids.systemWide = await write(org1Admin, null, USER_1);
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  const listIds = async (token: string, organizationFilter?: string) => {
    const res = await axios.get(`${BASE_URL}/entries`, {
      params: {
        "filter[source]": source,
        ...(organizationFilter && {
          "filter[organizationId]": organizationFilter,
        }),
      },
      ...auth(token),
    });
    return {
      status: res.status,
      ids:
        res.status === 200
          ? res.data.data.map((e: { id: string }) => e.id)
          : [],
    };
  };

  describe("GET /entries", () => {
    it("scopes to the token's organization without a filter", async () => {
      const result = await listIds(org1Admin);
      expect(result.status).toBe(HTTP_STATUS.OK);
      expect(result.ids).toEqual([ids.org1]);
    });

    it("lets audit-logs.admin read another organization", async () => {
      const result = await listIds(org1Admin, ORG_2);
      expect(result.status).toBe(HTTP_STATUS.OK);
      expect(result.ids).toEqual([ids.org2]);
    });

    it('lets audit-logs.admin read system-wide entries with "none"', async () => {
      const result = await listIds(org1Admin, "none");
      expect(result.status).toBe(HTTP_STATUS.OK);
      expect(result.ids).toEqual([ids.systemWide]);
    });

    it("lets a root admin token read across organizations and system-wide", async () => {
      const all = await listIds(rootAdmin);
      expect(all.status).toBe(HTTP_STATUS.OK);
      expect(all.ids.sort()).toEqual(
        [ids.org1, ids.org2, ids.systemWide].sort()
      );

      const systemWide = await listIds(rootAdmin, "none");
      expect(systemWide.ids).toEqual([ids.systemWide]);
    });

    it("refuses a non-admin naming another organization", async () => {
      const result = await listIds(org1Reader, ORG_2);
      expect(result.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it('refuses a non-admin asking for "none"', async () => {
      const result = await listIds(org1Reader, "none");
      expect(result.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it("lets a non-admin name their own organization", async () => {
      const result = await listIds(org1Reader, ORG_1);
      expect(result.status).toBe(HTTP_STATUS.OK);
      expect(result.ids).toEqual([ids.org1]);
    });

    it("refuses a non-admin token without an organization", async () => {
      const noOrgReader = await getTestPrincipalToken({
        organizationId: null,
        permissions: ["audit-logs.read"],
      });
      expect((await listIds(noOrgReader)).status).toBe(HTTP_STATUS.FORBIDDEN);
      expect((await listIds(noOrgReader, "none")).status).toBe(
        HTTP_STATUS.FORBIDDEN
      );
    });

    it("returns 400 for a filter that is neither a uuid nor none", async () => {
      const result = await listIds(org1Admin, "everything");
      expect(result.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("names the user, writer and organization", async () => {
      const res = await axios.get(`${BASE_URL}/entries`, {
        params: { "filter[source]": source },
        ...auth(org1Admin),
      });
      expect(res.status).toBe(HTTP_STATUS.OK);
      const [entry] = res.data.data;
      expect(entry.user).toEqual({
        id: USER_1,
        email: `test-user-${USER_1}@example.com`,
        name: `Test User ${USER_1}`,
      });
      expect(entry.writer).toMatchObject({ id: USER_1 });
      expect(entry.organization).toEqual({
        id: ORG_1,
        name: expect.any(String),
        slug: expect.any(String),
      });

      const systemWide = await axios.get(`${BASE_URL}/entries`, {
        params: {
          "filter[source]": source,
          "filter[organizationId]": "none",
        },
        ...auth(org1Admin),
      });
      expect(systemWide.data.data[0].organization).toBeNull();
    });
  });

  describe("GET /entries/:id", () => {
    it("returns 404 for another organization's entry without a filter", async () => {
      const res = await axios.get(
        `${BASE_URL}/entries/${ids.org2}`,
        auth(org1Admin)
      );
      expect(res.status).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it("lets audit-logs.admin read it with the filter", async () => {
      const res = await axios.get(`${BASE_URL}/entries/${ids.org2}`, {
        params: { "filter[organizationId]": ORG_2 },
        ...auth(org1Admin),
      });
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.data.organization).toMatchObject({ id: ORG_2 });
      expect(res.data.user).toMatchObject({ id: USER_2 });
    });

    it('lets audit-logs.admin read a system-wide entry with "none"', async () => {
      const res = await axios.get(`${BASE_URL}/entries/${ids.systemWide}`, {
        params: { "filter[organizationId]": "none" },
        ...auth(org1Admin),
      });
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.data.organizationId).toBeNull();
    });

    it("refuses a non-admin naming another organization", async () => {
      const res = await axios.get(`${BASE_URL}/entries/${ids.org2}`, {
        params: { "filter[organizationId]": ORG_2 },
        ...auth(org1Reader),
      });
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    });
  });

  describe("GET /entries/entity/:entityType/:entityId", () => {
    const history = (token: string, organizationFilter?: string) =>
      axios.get(`${BASE_URL}/entries/entity/${entityType}/${entityId}`, {
        params: organizationFilter
          ? { "filter[organizationId]": organizationFilter }
          : {},
        ...auth(token),
      });

    it("scopes to the token's organization without a filter", async () => {
      const res = await history(org1Admin);
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.data.data.map((e: { id: string }) => e.id)).toEqual([
        ids.org1,
      ]);
      expect(res.data.data[0].user).toMatchObject({ id: USER_1 });
    });

    it("lets audit-logs.admin read another organization and system-wide", async () => {
      const org2 = await history(org1Admin, ORG_2);
      expect(org2.data.data.map((e: { id: string }) => e.id)).toEqual([
        ids.org2,
      ]);

      const systemWide = await history(org1Admin, "none");
      expect(systemWide.data.data.map((e: { id: string }) => e.id)).toEqual([
        ids.systemWide,
      ]);
    });

    it("refuses a non-admin naming another organization", async () => {
      const res = await history(org1Reader, ORG_2);
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    });
  });

  describe("GET /entries/facets", () => {
    const facets = (token: string, organizationFilter?: string) =>
      axios.get(`${BASE_URL}/entries/facets`, {
        params: organizationFilter
          ? { "filter[organizationId]": organizationFilter }
          : {},
        ...auth(token),
      });

    it("lists distinct sources and entity types in the caller's organization", async () => {
      const res = await facets(org1Reader);
      expect(res.status).toBe(HTTP_STATUS.OK);
      expect(res.data.sources).toContain(source);
      expect(res.data.entityTypes).toContain(entityType);
      expect(new Set(res.data.sources).size).toBe(res.data.sources.length);
      expect([...res.data.sources].sort()).toEqual(res.data.sources);
    });

    it("follows the organization filter for audit-logs.admin", async () => {
      const org2Only = `test-scope-only-${runId}`;
      const org2Admin = await getTestAccessToken(USER_2, ORG_2);
      await axios.post(
        `${BASE_URL}/entries`,
        {
          source: org2Only,
          organizationId: ORG_2,
          userId: USER_2,
          userEmail: `test-scope-${runId}@example.com`,
          action: "CREATE",
          entityType,
          entityId,
        },
        auth(org2Admin)
      );

      const own = await facets(org1Admin);
      expect(own.data.sources).not.toContain(org2Only);

      const other = await facets(org1Admin, ORG_2);
      expect(other.data.sources).toContain(org2Only);

      const systemWide = await facets(org1Admin, "none");
      expect(systemWide.data.sources).toContain(source);
      expect(systemWide.data.sources).not.toContain(org2Only);
    });

    it("refuses a non-admin naming another organization", async () => {
      const res = await facets(org1Reader, ORG_2);
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it("returns 403 without audit-logs.read", async () => {
      const token = await getTestPrincipalToken({
        organizationId: ORG_1,
        permissions: ["other.read"],
      });
      const res = await facets(token);
      expect(res.status).toBe(HTTP_STATUS.FORBIDDEN);
    });
  });
});
