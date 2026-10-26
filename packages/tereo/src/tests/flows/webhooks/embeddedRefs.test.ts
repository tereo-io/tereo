// @module-tag int
// @module-tag webhooks
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  cleanupTestEntities,
  createTestWebhookEndpoint,
  getTestAccessToken,
  getTestUserId,
} from "../../support/webhooks.js";

describe("Webhook endpoints name their creator", () => {
  let token: string;
  let creator: { id: string; email: string; name: string | null };

  beforeAll(async () => {
    token = await getTestAccessToken();
    creator = await prisma.user.findUniqueOrThrow({
      where: { id: getTestUserId() },
      select: { id: true, email: true, name: true },
    });
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("on create, read, update and list", async () => {
    const endpoint = await createTestWebhookEndpoint(token);
    expect(endpoint).toMatchObject({ createdBy: creator.id, creator });

    const headers = { Authorization: `Bearer ${token}` };
    const got = await axios.get(`${BASE_URL}/webhooks/${endpoint.id}`, {
      headers,
    });
    expect(got.status).toBe(HTTP_STATUS.OK);
    expect(got.data.creator).toEqual(creator);

    const patched = await axios.patch(
      `${BASE_URL}/webhooks/${endpoint.id}`,
      { description: "renamed" },
      { headers }
    );
    expect(patched.status).toBe(HTTP_STATUS.OK);
    expect(patched.data.creator).toEqual(creator);

    const listed = await axios.get(`${BASE_URL}/webhooks`, {
      headers,
      params: { "filter[url]": endpoint.url, "filter[url_op]": "contains" },
    });
    const row = listed.data.data.find(
      (e: { id: string }) => e.id === endpoint.id
    );
    expect(row.creator).toEqual(creator);
  });
});
