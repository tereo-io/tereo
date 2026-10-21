import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  cleanupTestEntities,
  generateUniqueId,
} from "./utils/test-helpers.js";

const ORG_1 = "00000000-0000-7002-8000-000000000001";
const USER_1 = "00000000-0000-7001-8000-000000000001";

// Input that once reached Postgres and failed there with a 500.
describe("Audit input Postgres cannot take", () => {
  const runId = generateUniqueId();
  let token: string;
  const cfg = () => ({
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });
  const entry = {
    source: `test-input-${runId}`,
    organizationId: ORG_1,
    userId: USER_1,
    userEmail: `test-input-${runId}@example.com`,
    action: "CREATE",
    entityType: "InputEntity",
    entityId: `input-${runId}`,
  };

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  const get = (path: string) => axios.get(`${BASE_URL}${path}`, cfg());

  it.each([
    ["a userId filter that is not a uuid", "/entries?filter[userId]=nope"],
    [
      "a userId filter that is not a uuid, on entity history",
      "/entries/entity/InputEntity/x?filter[userId]=nope",
    ],
    [
      "a createdAt bound outside the years 1-9999",
      "/entries?filter[createdAt_gte]=-271821-04-20T00:00:00Z",
    ],
    ["a NUL in filter[q]", "/entries?filter[q]=a%00b"],
    ["a NUL in a filter value", "/entries?filter[entityName]=%00"],
    ["a NUL in a metadata filter", "/entries?metadata[k_equals]=%00"],
    ["a NUL in the entity path", "/entries/entity/InputEntity/a%00b"],
    ["a metadata filter with no operator", "/entries?metadata[k]=x"],
    [
      "a repeated metadata filter",
      "/entries?metadata[k_equals]=x&metadata[k_equals]=y",
    ],
    [
      "a metadata filter key over 100 characters",
      `/entries?metadata[${"k".repeat(101)}_equals]=x`,
    ],
    [
      "a metadata filter value over 500 characters",
      `/entries?metadata[k_equals]=${"v".repeat(501)}`,
    ],
    [
      "more than 20 metadata filters",
      `/entries?${Array.from({ length: 21 }, (_, i) => `metadata[k${i}_equals]=x`).join("&")}`,
    ],
    ["a repeated filter[q]", "/entries?filter[q]=a&filter[q]=b"],
    [
      "a filter value over 500 characters",
      `/entries?filter[entityName]=${"n".repeat(501)}`,
    ],
    [
      "a repeated filter[organizationId]",
      `/entries?filter[organizationId]=${ORG_1}&filter[organizationId]=${ORG_1}`,
    ],
    [
      "a filter[organizationId] that is not an id",
      "/entries?filter[organizationId]=nope",
    ],
  ])("refuses %s with a 400", async (_label, path) => {
    const res = await get(path);
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.data.error).toBe("invalid_request");
  });

  it.each([
    ["entityId", { entityId: "a\u0000b" }],
    ["source", { source: "a\u0000" }],
    ["a metadata value", { metadata: { nested: ["x\u0000y"] } }],
    ["a changes key", { changes: { "a\u0000": { new: 1 } } }],
  ])("refuses a NUL in %s with a 400", async (_label, override) => {
    const res = await axios.post(
      `${BASE_URL}/entries`,
      { ...entry, ...override },
      cfg()
    );
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.data.error).toBe("invalid_request");
  });

  it.each([
    ["metadata", { metadata: { big: "x".repeat(64 * 1024) } }],
    ["changes", { changes: { big: { new: "x".repeat(64 * 1024) } } }],
  ])("refuses %s over 64 KiB as JSON with a 400", async (_label, override) => {
    const res = await axios.post(
      `${BASE_URL}/entries`,
      { ...entry, ...override },
      cfg()
    );
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(res.data.error).toBe("invalid_request");
  });

  it("still reads metadata filters and filter[organizationId]=none", async () => {
    const ok = await get(
      `/entries?metadata[k_equals]=x&metadata[j_contains]=&filter[organizationId]=${ORG_1}`
    );
    expect(ok.status).toBe(HTTP_STATUS.OK);
  });

  it("refuses a NUL in a batch entry, writing nothing", async () => {
    const res = await axios.post(
      `${BASE_URL}/entries/batch`,
      { entries: [entry, { ...entry, entityName: "\u0000" }] },
      cfg()
    );
    expect(res.status).toBe(HTTP_STATUS.BAD_REQUEST);
    const written = await prisma.auditLogEntry.count({
      where: { source: entry.source },
    });
    expect(written).toBe(0);
  });

  it("accepts an IPv4-mapped IPv6 address, as Express reports one", async () => {
    const res = await axios.post(
      `${BASE_URL}/entries`,
      { ...entry, ipAddress: "::ffff:203.0.113.7" },
      cfg()
    );
    expect(res.status).toBe(HTTP_STATUS.CREATED);
    expect(res.data.ipAddress).toBe("::ffff:203.0.113.7");
  });
});

describe("Audit pagination across entries written in the same millisecond", () => {
  const runId = generateUniqueId();
  const entityType = `TieEntity${runId}`;
  let token: string;
  let ids: string[];

  beforeAll(async () => {
    token = await getTestAccessToken();
    const createdAt = new Date();
    const rows = await Promise.all(
      [0, 1, 2, 3].map(() =>
        prisma.auditLogEntry.create({
          data: {
            source: `test-tie-${runId}`,
            organizationId: ORG_1,
            userId: USER_1,
            userEmail: `test-tie-${runId}@example.com`,
            action: "UPDATE",
            entityType,
            entityId: `tie-${runId}`,
            entityName: `tie-name-${runId}`,
            writerUserId: USER_1,
            createdAt,
          },
        })
      )
    );
    ids = rows.map((r) => r.id).sort();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  const pageThrough = async (query: string) => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const res: { status: number; data: Record<string, unknown> } =
        await axios.get(
          `${BASE_URL}/entries?${query}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            validateStatus: () => true,
          }
        );
      expect(res.status).toBe(HTTP_STATUS.OK);
      seen.push(...(res.data.data as { id: string }[]).map((e) => e.id));
      if (!res.data.hasMore) break;
      cursor = res.data.nextCursor as string;
    }
    return seen;
  };

  it.each(["desc", "asc"])(
    "lists every tied entry once, by id, sorted %s",
    async (dir) => {
      expect(
        await pageThrough(`filter[entityType]=${entityType}&sortDir=${dir}`)
      ).toEqual(ids);
    }
  );

  it.each(["desc", "asc"])(
    "searches every tied entry once, by id, sorted %s",
    async (dir) => {
      expect(
        await pageThrough(`filter[q]=tie-name-${runId}&sortDir=${dir}`)
      ).toEqual(ids);
    }
  );
});
