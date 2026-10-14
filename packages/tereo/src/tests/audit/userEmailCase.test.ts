import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  generateUniqueId,
  getTestAccessToken,
  getTestOrgId,
  getTestUserId,
} from "./utils/test-helpers.js";

const auth = (token: string) => ({
  headers: { Authorization: `Bearer ${token}` },
  validateStatus: () => true,
});

describe("Audit userEmail case", () => {
  const runId = generateUniqueId();
  const source = `test-email-case-${runId}`;
  const entityType = `EmailCaseEntity${runId}`;
  const entityId = `email-case-${runId}`;
  // Unique per run, so a search never matches another file's entries.
  const term = `Ec${runId}`;
  let token: string;

  const entry = (userEmail: string) => ({
    source,
    organizationId: getTestOrgId(),
    userId: getTestUserId(),
    userEmail,
    action: "UPDATE",
    entityType,
    entityId,
    entityName: term,
  });

  const list = async (params: Record<string, string>) => {
    const res = await axios.get(`${BASE_URL}/entries`, {
      params: { "filter[source]": source, ...params },
      ...auth(token),
    });
    expect(res.status).toBe(HTTP_STATUS.OK);
    return (res.data.data as { id: string }[]).map((e) => e.id);
  };

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("lower-cases userEmail on a single write", async () => {
    const res = await axios.post(
      `${BASE_URL}/entries`,
      entry(`Test-Single-${runId}@Example.COM`),
      auth(token)
    );
    expect(res.status).toBe(HTTP_STATUS.CREATED);
    expect(res.data.userEmail).toBe(`test-single-${runId}@example.com`);
  });

  it("lower-cases userEmail on a batch write", async () => {
    const res = await axios.post(
      `${BASE_URL}/entries/batch`,
      { entries: [entry(`TEST-Batch-${runId}@Example.com`)] },
      auth(token)
    );
    expect(res.status).toBe(HTTP_STATUS.CREATED);
    const row = await prisma.auditLogEntry.findFirstOrThrow({
      where: { source, userEmail: { startsWith: "test-batch-" } },
    });
    expect(row.userEmail).toBe(`test-batch-${runId}@example.com`);
  });

  describe("filtering", () => {
    const ids = { legacy: "", underscore: "", lookalike: "" };

    beforeAll(async () => {
      // A row written before emails were lower-cased.
      ids.legacy = (
        await prisma.auditLogEntry.create({
          data: {
            ...entry(`Test-Legacy-${runId}@Example.COM`),
            action: "UPDATE",
            writerUserId: getTestUserId(),
          },
        })
      ).id;
      const write = async (email: string) => {
        const res = await axios.post(
          `${BASE_URL}/entries`,
          entry(email),
          auth(token)
        );
        expect(res.status).toBe(HTTP_STATUS.CREATED);
        return res.data.id as string;
      };
      ids.underscore = await write(`test-a_b-${runId}@example.com`);
      ids.lookalike = await write(`test-axb-${runId}@example.com`);
    });

    it("matches a mixed-case row in any case, without filter[q] and with it", async () => {
      for (const email of [
        `test-legacy-${runId}@example.com`,
        `TEST-LEGACY-${runId}@EXAMPLE.COM`,
      ]) {
        expect(await list({ "filter[userEmail]": email })).toEqual([
          ids.legacy,
        ]);
        expect(
          await list({ "filter[userEmail]": email, "filter[q]": term })
        ).toEqual([ids.legacy]);
      }
    });

    it("treats LIKE wildcards in an exact match literally", async () => {
      const email = `test-a_b-${runId}@example.com`;
      expect(await list({ "filter[userEmail]": email })).toEqual([
        ids.underscore,
      ]);
      expect(
        await list({ "filter[userEmail]": email, "filter[q]": term })
      ).toEqual([ids.underscore]);
    });

    it("matches a substring in any case", async () => {
      expect(
        await list({
          "filter[userEmail]": `LEGACY-${runId}`,
          "filter[userEmail_op]": "contains",
        })
      ).toEqual([ids.legacy]);
    });
  });
});
