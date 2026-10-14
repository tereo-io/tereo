import { describe, it, expect, beforeAll, afterAll } from "vitest";
import axios from "axios";
import {
  BASE_URL,
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

describe("audit contains filters", () => {
  const runId = generateUniqueId();
  const source = `test-wild-${runId}`;
  let token: string;

  const write = async (
    entityId: string,
    entityName: string,
    metadata: Record<string, unknown>
  ) => {
    const res = await axios.post(
      `${BASE_URL}/entries`,
      {
        source,
        organizationId: getTestOrgId(),
        userId: getTestUserId(),
        userEmail: `test-wild-${runId}@example.com`,
        action: "UPDATE",
        entityType: "Wild",
        entityId,
        entityName,
        metadata,
      },
      auth(token)
    );
    expect(res.status).toBe(201);
  };

  const list = async (params: Record<string, string>) => {
    const res = await axios.get(`${BASE_URL}/entries`, {
      params: { "filter[source]": source, ...params },
      ...auth(token),
    });
    expect(res.status).toBe(200);
    return (res.data.data as { entityId: string }[])
      .map((e) => e.entityId)
      .sort();
  };

  beforeAll(async () => {
    token = await getTestAccessToken();
    await write("underscore", `n_${runId}`, { k: `a_b${runId}` });
    await write("lookalike", `nx${runId}`, { k: `axb${runId}` });
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("treats LIKE wildcards in an entityName contains filter literally", async () => {
    expect(
      await list({
        "filter[entityName]": `n_${runId}`,
        "filter[entityName_op]": "contains",
      })
    ).toEqual(["underscore"]);
  });

  it("treats LIKE wildcards in a metadata contains filter literally", async () => {
    expect(await list({ "metadata[k_contains]": `a_b${runId}` })).toEqual([
      "underscore",
    ]);
  });

  it("answers the same with filter[q] as without it", async () => {
    const params = {
      "filter[entityName]": `n_${runId}`,
      "filter[entityName_op]": "contains",
    };
    expect(await list(params)).toEqual(
      await list({ ...params, "filter[q]": runId })
    );
  });
});
