import { describe, it, expect, beforeAll, afterAll } from "vitest";
import axios from "axios";
import {
  BASE_URL,
  cleanupTestEntities,
  generateUniqueId,
  getTestAccessToken,
  getTestOrgId,
  getTestUserId,
} from "../support/audit.js";

const auth = (token: string) => ({
  headers: { Authorization: `Bearer ${token}` },
  validateStatus: () => true,
});

describe("filter[q] on values that JSON escapes", () => {
  const runId = generateUniqueId();
  const source = `test-jsonq-${runId}`;
  let token: string;

  const list = async (q: string) => {
    const res = await axios.get(`${BASE_URL}/entries`, {
      params: { "filter[source]": source, "filter[q]": q },
      ...auth(token),
    });
    expect(res.status).toBe(200);
    return (res.data.data as { entityId: string }[]).map((e) => e.entityId);
  };

  beforeAll(async () => {
    token = await getTestAccessToken();
    const res = await axios.post(
      `${BASE_URL}/entries`,
      {
        source,
        organizationId: getTestOrgId(),
        userId: getTestUserId(),
        userEmail: `test-jsonq-${runId}@example.com`,
        action: "UPDATE",
        entityType: "JsonQ",
        entityId: "holder",
        changes: { comment: { old: null, new: `line one\nline two ${runId}` } },
        metadata: {
          path: `C:\\exports\\${runId}`,
          note: `said "approved ${runId}"`,
        },
      },
      auth(token)
    );
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("finds a metadata value containing a backslash", async () => {
    expect(await list(`C:\\exports\\${runId}`)).toEqual(["holder"]);
  });

  it("finds a metadata value containing a double quote", async () => {
    expect(await list(`"approved ${runId}"`)).toEqual(["holder"]);
  });

  it("finds a changes value containing a newline", async () => {
    expect(await list(`line one\nline two ${runId}`)).toEqual(["holder"]);
  });

  it("still escapes LIKE wildcards in the JSON-escaped form", async () => {
    // Unescaped, `__` would match the stored `\\` between the two parts.
    expect(await list(`C:\\exports__${runId}`)).toEqual([]);
  });
});
