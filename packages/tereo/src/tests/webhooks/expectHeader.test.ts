import { describe, it, expect, beforeAll, afterAll } from "vitest";
import axios from "axios";
import {
  BASE_URL,
  HTTP_STATUS,
  getTestAccessToken,
  createTestEventType,
  createTestWebhookEndpoint,
  cleanupTestEntities,
  generateUniqueId,
} from "./utils/test-helpers.js";

describe("Expect as a custom webhook header", () => {
  let token: string;

  beforeAll(async () => {
    token = await getTestAccessToken();
  });

  afterAll(async () => {
    await cleanupTestEntities();
  });

  it("is something fetch refuses to send, failing every delivery", async () => {
    await expect(
      fetch("http://127.0.0.1:1/", {
        method: "POST",
        body: "{}",
        headers: { Expect: "100-continue" },
      })
    ).rejects.toThrow();
  });

  it("returns 400 on create and update", async () => {
    const et = await createTestEventType(token);
    const auth = {
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    };
    const endpoint = await createTestWebhookEndpoint(token, {
      eventTypes: [et.eventType],
    });

    const create = await axios.post(
      `${BASE_URL}/webhooks`,
      {
        url: `https://example.com/webhook/${generateUniqueId()}`,
        eventTypes: [et.eventType],
        customHeaders: { Expect: "100-continue" },
      },
      auth
    );
    expect(create.status).toBe(HTTP_STATUS.BAD_REQUEST);

    const update = await axios.patch(
      `${BASE_URL}/webhooks/${endpoint.id}`,
      { customHeaders: { expect: "100-continue" } },
      auth
    );
    expect(update.status).toBe(HTTP_STATUS.BAD_REQUEST);
  });
});
