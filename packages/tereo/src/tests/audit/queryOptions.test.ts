import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { getTestPrincipalToken } from "../support/principals.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  cleanupTestEntities,
  generateUniqueId,
} from "../support/audit.js";

const ORG_1 = "00000000-0000-7002-8000-000000000001";
const ORG_2 = "00000000-0000-7002-8000-000000000002";
const USER_1 = "00000000-0000-7001-8000-000000000001";
const USER_2 = "00000000-0000-7001-8000-000000000002";
const DAY_MS = 24 * 60 * 60 * 1000;

const auth = (token: string) => ({
  headers: { Authorization: `Bearer ${token}` },
  validateStatus: () => true,
});

interface Entry {
  id: string;
  writerUserId: string;
  userEmail: string | null;
}

describe("Audit query options", () => {
  const runId = generateUniqueId();
  const source = `test-query-${runId}`;
  const entityType = `QueryEntity${runId}`;
  const entityId = `query-${runId}`;
  const emailA = `test-query-${runId}-alice@example.com`;
  const emailB = `test-query-${runId}-bob@example.com`;
  // Unique per run, so a search never matches another file's entries.
  const term = `Zq${runId}`;
  const keyA = `qa_${runId}`;
  const keyB = `qb_${runId}`;
  const keyOrg2 = `qo2_${runId}`;
  const keySystem = `qsys_${runId}`;

  let org1Admin: string;
  let org1Reader: string;
  let otherWriterId: string;
  const ids = {
    byAdmin: "",
    byOtherWriter: "",
    inName: "",
    inChanges: "",
    inMetadata: "",
    org2: "",
    systemWide: "",
  };

  const write = async (token: string, body: Record<string, unknown>) => {
    const res = await axios.post(
      `${BASE_URL}/entries`,
      {
        source,
        organizationId: ORG_1,
        userId: USER_1,
        userEmail: emailA,
        action: "UPDATE",
        entityType,
        entityId,
        ...body,
      },
      auth(token)
    );
    expect(res.status).toBe(HTTP_STATUS.CREATED);
    return res.data as Entry;
  };

  beforeAll(async () => {
    org1Admin = await getTestAccessToken(USER_1, ORG_1);
    org1Reader = await getTestPrincipalToken({
      organizationId: ORG_1,
      permissions: ["audit-logs.read"],
    });
    const otherWriter = await getTestPrincipalToken({
      organizationId: ORG_1,
      permissions: ["audit-logs.write"],
    });
    const org2Admin = await getTestAccessToken(USER_2, ORG_2);

    ids.byAdmin = (await write(org1Admin, {})).id;
    const byOther = await write(otherWriter, { userEmail: emailB });
    ids.byOtherWriter = byOther.id;
    otherWriterId = byOther.writerUserId;

    ids.inName = (
      await write(org1Admin, {
        entityName: `Invoice ${term.toLowerCase()} draft`,
        metadata: { [keyA]: "north" },
      })
    ).id;
    ids.inChanges = (
      await write(org1Admin, {
        changes: { status: { old: "open", new: `closed by ${term}` } },
        metadata: { [keyA]: "south", [keyB]: 7 },
      })
    ).id;
    ids.inMetadata = (
      await write(org1Admin, {
        metadata: { note: `see ${term.toUpperCase()}` },
      })
    ).id;
    ids.org2 = (
      await write(org2Admin, {
        organizationId: ORG_2,
        userId: USER_2,
        entityName: term,
        metadata: { [keyOrg2]: "x" },
      })
    ).id;
    ids.systemWide = (
      await write(org1Admin, {
        organizationId: null,
        entityName: term,
        metadata: { [keySystem]: "x" },
      })
    ).id;
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  const list = async (
    params: Record<string, string>,
    token: string = org1Admin
  ) => {
    const res = await axios.get(`${BASE_URL}/entries`, {
      params: { "filter[source]": source, ...params },
      ...auth(token),
    });
    return {
      status: res.status,
      error: res.data?.error as string | undefined,
      ids: res.status === 200 ? res.data.data.map((e: Entry) => e.id) : [],
      body: res.data,
    };
  };

  const history = async (params: Record<string, string>) => {
    const res = await axios.get(
      `${BASE_URL}/entries/entity/${entityType}/${entityId}`,
      { params, ...auth(org1Admin) }
    );
    expect(res.status).toBe(HTTP_STATUS.OK);
    return res.data.data.map((e: Entry) => e.id) as string[];
  };

  describe("writer and email filters", () => {
    it("filters the list by writerUserId", async () => {
      const result = await list({ "filter[writerUserId]": otherWriterId });
      expect(result.status).toBe(HTTP_STATUS.OK);
      expect(result.ids).toEqual([ids.byOtherWriter]);

      const own = await list({ "filter[writerUserId]": USER_1 });
      expect(own.ids).not.toContain(ids.byOtherWriter);
      expect(own.ids).toContain(ids.byAdmin);
    });

    it("rejects a writerUserId that is not a uuid", async () => {
      const result = await list({ "filter[writerUserId]": "nobody" });
      expect(result.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("filters the list by userEmail, exactly or by substring", async () => {
      const exact = await list({ "filter[userEmail]": emailB });
      expect(exact.ids).toEqual([ids.byOtherWriter]);

      const partial = await list({
        "filter[userEmail]": `${runId}-BOB`,
        "filter[userEmail_op]": "contains",
      });
      expect(partial.ids).toEqual([ids.byOtherWriter]);
    });

    it("filters entity history by writerUserId and userEmail", async () => {
      expect(await history({ "filter[writerUserId]": otherWriterId })).toEqual([
        ids.byOtherWriter,
      ]);
      expect(await history({ "filter[userEmail]": emailB })).toEqual([
        ids.byOtherWriter,
      ]);
      const alice = await history({
        "filter[userEmail]": "alice",
        "filter[userEmail_op]": "contains",
      });
      expect(alice).not.toContain(ids.byOtherWriter);
      expect(alice).toContain(ids.byAdmin);
    });
  });

  describe("filter[q]", () => {
    it("matches entity names, changes and metadata, ignoring case", async () => {
      const result = await list({ "filter[q]": term });
      expect(result.status).toBe(HTTP_STATUS.OK);
      expect(result.ids.sort()).toEqual(
        [ids.inName, ids.inChanges, ids.inMetadata].sort()
      );
    });

    it("returns nothing when no entry matches", async () => {
      const result = await list({ "filter[q]": `${term}-absent` });
      expect(result.status).toBe(HTTP_STATUS.OK);
      expect(result.ids).toEqual([]);
      expect(result.body.hasMore).toBe(false);
    });

    it("treats LIKE wildcards literally", async () => {
      const result = await list({ "filter[q]": "%" });
      expect(result.status).toBe(HTTP_STATUS.OK);
      expect(result.ids).toEqual([]);
    });

    it("combines with the other filters", async () => {
      const inChangesOnly = await list({
        "filter[q]": term,
        [`metadata[${keyA}_equals]`]: "south",
      });
      expect(inChangesOnly.ids).toEqual([ids.inChanges]);

      const contains = await list({
        "filter[q]": term,
        [`metadata[${keyA}_contains]`]: "or",
      });
      expect(contains.ids).toEqual([ids.inName]);

      const byEmail = await list({
        "filter[q]": term,
        "filter[userEmail]": emailB,
      });
      expect(byEmail.ids).toEqual([]);
    });

    it("pages through matches with the cursor", async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 3; page++) {
        const result = await list({
          "filter[q]": term,
          limit: "1",
          ...(cursor && { cursor }),
        });
        expect(result.status).toBe(HTTP_STATUS.OK);
        seen.push(...result.ids);
        expect(result.body.hasMore).toBe(page < 2);
        cursor = result.body.nextCursor ?? undefined;
      }
      expect(seen.sort()).toEqual(
        [ids.inName, ids.inChanges, ids.inMetadata].sort()
      );
    });

    it("keeps to the caller's organization", async () => {
      const own = await list({ "filter[q]": term }, org1Reader);
      expect(own.ids).not.toContain(ids.org2);
      expect(own.ids).not.toContain(ids.systemWide);

      const org2 = await list({
        "filter[q]": term,
        "filter[organizationId]": ORG_2,
      });
      expect(org2.ids).toEqual([ids.org2]);

      const systemWide = await list({
        "filter[q]": term,
        "filter[organizationId]": "none",
      });
      expect(systemWide.ids).toEqual([ids.systemWide]);

      const refused = await list(
        { "filter[q]": term, "filter[organizationId]": ORG_2 },
        org1Reader
      );
      expect(refused.status).toBe(HTTP_STATUS.FORBIDDEN);
    });

    it("searches only the requested createdAt window", async () => {
      const yesterday = new Date(Date.now() - DAY_MS).toISOString();
      const result = await list({
        "filter[q]": term,
        "filter[createdAt_lte]": yesterday,
      });
      expect(result.status).toBe(HTTP_STATUS.OK);
      expect(result.ids).toEqual([]);
    });

    it("refuses a window longer than 31 days", async () => {
      const result = await list({
        "filter[q]": term,
        "filter[createdAt_gte]": new Date(
          Date.now() - 40 * DAY_MS
        ).toISOString(),
      });
      expect(result.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(result.error).toBe("search_window_too_large");

      const unbounded = await list({ "filter[createdAt_gte]": "2000-01-01" });
      expect(unbounded.status).toBe(HTTP_STATUS.OK);
    });

    it("tolerates a client clock a little ahead when computing 31 days ago", async () => {
      const result = await list({
        "filter[q]": term,
        "filter[createdAt_gte]": new Date(
          Date.now() - 31 * DAY_MS - 2 * 60 * 1000
        ).toISOString(),
      });
      expect(result.status).toBe(HTTP_STATUS.OK);
    });

    it("refuses a long window given in _op form, whatever the order", async () => {
      const old = new Date(Date.now() - 40 * DAY_MS).toISOString();
      const now = new Date(Date.now() + DAY_MS).toISOString();
      const lteFirst = await list({
        "filter[q]": term,
        "filter[createdAt_lte]": now,
        "filter[createdAt]": old,
        "filter[createdAt_op]": "gte",
      });
      expect(lteFirst.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(lteFirst.error).toBe("search_window_too_large");

      const gteFirst = await list({
        "filter[q]": term,
        "filter[createdAt]": old,
        "filter[createdAt_op]": "gte",
        "filter[createdAt_lte]": now,
      });
      expect(gteFirst.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(gteFirst.error).toBe("search_window_too_large");

      const repeated = await axios.get(
        `${BASE_URL}/entries?filter[q]=${term}` +
          `&filter[createdAt]=${old}&filter[createdAt]=${now}` +
          `&filter[createdAt_op]=gte&filter[createdAt_op]=lte`,
        auth(org1Admin)
      );
      expect(repeated.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(repeated.data.error).toBe("search_window_too_large");
    });

    it("applies both bounds of a range whatever their form or order", async () => {
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const yesterday = new Date(Date.now() - DAY_MS).toISOString();
      const matches = [ids.inName, ids.inChanges, ids.inMetadata].sort();

      const current = await list({
        "filter[q]": term,
        "filter[createdAt_lte]": new Date(Date.now() + DAY_MS).toISOString(),
        "filter[createdAt]": hourAgo,
        "filter[createdAt_op]": "gte",
      });
      expect(current.status).toBe(HTTP_STATUS.OK);
      expect(current.ids.sort()).toEqual(matches);

      // The lte bound must survive the later _op key, not be replaced by it.
      const past = await list({
        "filter[createdAt_lte]": yesterday,
        "filter[createdAt]": "2000-01-01",
        "filter[createdAt_op]": "gte",
      });
      expect(past.status).toBe(HTTP_STATUS.OK);
      expect(past.ids).toEqual([]);

      const pastReversed = await list({
        "filter[createdAt]": "2000-01-01",
        "filter[createdAt_op]": "gte",
        "filter[createdAt_lte]": yesterday,
      });
      expect(pastReversed.status).toBe(HTTP_STATUS.OK);
      expect(pastReversed.ids).toEqual([]);
    });

    it("rejects a repeated or blank search", async () => {
      const repeated = await axios.get(
        `${BASE_URL}/entries?filter[q]=a&filter[q]=b`,
        auth(org1Admin)
      );
      expect(repeated.status).toBe(HTTP_STATUS.BAD_REQUEST);

      const blank = await list({ "filter[q]": "   " });
      expect(blank.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });
  });

  describe("GET /entries/facets metadataKeys", () => {
    const facets = (token: string, organizationFilter?: string) =>
      axios.get(`${BASE_URL}/entries/facets`, {
        params: organizationFilter
          ? { "filter[organizationId]": organizationFilter }
          : {},
        ...auth(token),
      });

    it("lists the top-level metadata keys in the caller's organization", async () => {
      const res = await facets(org1Reader);
      expect(res.status).toBe(HTTP_STATUS.OK);
      const keys = res.data.metadataKeys as string[];
      expect(keys).toEqual(expect.arrayContaining([keyA, keyB, "note"]));
      expect(keys).not.toContain(keyOrg2);
      expect(keys).not.toContain(keySystem);
      expect(new Set(keys).size).toBe(keys.length);
      expect([...keys].sort()).toEqual(keys);
    });

    it("draws only from the requested createdAt window", async () => {
      const window = (params: Record<string, string>) =>
        axios.get(`${BASE_URL}/entries/facets`, {
          params,
          ...auth(org1Reader),
        });

      const recent = await window({
        "filter[createdAt_gte]": new Date(Date.now() - DAY_MS).toISOString(),
      });
      expect(recent.status).toBe(HTTP_STATUS.OK);
      expect(recent.data.sources).toContain(source);
      expect(recent.data.entityTypes).toContain(entityType);
      expect(recent.data.metadataKeys).toContain(keyA);

      const before = await window({
        "filter[createdAt_lte]": new Date(Date.now() - DAY_MS).toISOString(),
      });
      expect(before.status).toBe(HTTP_STATUS.OK);
      expect(before.data.sources).not.toContain(source);
      expect(before.data.entityTypes).not.toContain(entityType);
      expect(before.data.metadataKeys).not.toContain(keyA);

      const bad = await window({ "filter[createdAt_gte]": "not-a-date" });
      expect(bad.status).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it("follows the organization filter for audit-logs.admin", async () => {
      const org2 = await facets(org1Admin, ORG_2);
      expect(org2.data.metadataKeys).toContain(keyOrg2);
      expect(org2.data.metadataKeys).not.toContain(keyA);

      const systemWide = await facets(org1Admin, "none");
      expect(systemWide.data.metadataKeys).toContain(keySystem);
      expect(systemWide.data.metadataKeys).not.toContain(keyA);
    });
  });
});
