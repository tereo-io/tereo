// @module-tag unit
// @module-tag webhooks
import { describe, it, expect } from "vitest";
import {
  createWebhookEndpointSchema,
  customHeadersSchema,
  getWebhookEndpointsQuerySchema,
  listWebhookEndpointsExtraQuerySchema,
} from "../../../../../routes/v1/webhooks/webhooks/schemas.js";

const NUL = "must not contain a NUL character";

const endpoint = {
  url: "https://example.com/webhook",
  eventTypes: ["test.event"],
};

describe("/v1/webhooks/webhooks", () => {
  describe("createWebhookEndpointSchema", () => {
    it.each([
      [
        "a missing url",
        { description: "Missing url", eventTypes: ["test.event"] },
      ],
      ["a url that is not a url", { ...endpoint, url: "not-a-valid-url" }],
      ["missing eventTypes", { url: endpoint.url }],
      ["an empty eventTypes array", { ...endpoint, eventTypes: [] }],
      ["a NUL in the description", { ...endpoint, description: "a\u0000" }],
      ["a NUL in an event type", { ...endpoint, eventTypes: ["a\u0000"] }],
      [
        "more than 100 event types",
        {
          ...endpoint,
          eventTypes: Array.from({ length: 101 }, (_, i) => `x.type-${i}`),
        },
      ],
      [
        "a NUL in a custom header value",
        { ...endpoint, customHeaders: { "X-A": "\u0000" } },
      ],
      [
        "a CRLF in a custom header value",
        { ...endpoint, customHeaders: { "X-A": "a\r\nb" } },
      ],
      [
        "a character fetch cannot send in a custom header value",
        { ...endpoint, customHeaders: { "X-A": "☃" } },
      ],
      [
        "a custom header named Expect, which fetch refuses to send",
        { ...endpoint, customHeaders: { Expect: "100-continue" } },
      ],
    ])("rejects %s", (_label, body) => {
      expect(createWebhookEndpointSchema.safeParse(body).success).toBe(false);
    });

    it("names the NUL in a description", () => {
      const result = createWebhookEndpointSchema.safeParse({
        ...endpoint,
        description: "a\u0000",
      });
      expect(result.error?.issues[0]).toMatchObject({
        path: ["description"],
        message: NUL,
      });
    });

    it("accepts 100 event types", () => {
      const eventTypes = Array.from({ length: 100 }, (_, i) => `x.type-${i}`);
      const result = createWebhookEndpointSchema.safeParse({
        ...endpoint,
        eventTypes,
      });
      expect(result.success).toBe(true);
    });
  });

  describe("customHeadersSchema", () => {
    const rejects = (headers: Record<string, string>) =>
      expect(customHeadersSchema.safeParse(headers).success).toBe(false);

    it("rejects two header names that differ only in case", () => {
      rejects({ "X-Api-Key": "one", "x-api-key": "two" });
    });

    it("rejects a reserved header name", () => {
      rejects({ "X-Webhook-Signature": "hack" });
    });

    it.each([
      "Connection",
      "transfer-encoding",
      "Keep-Alive",
      "Upgrade",
      "TE",
      "Trailer",
      "Proxy-Authorization",
      "proxy-connection",
      "Content-Length",
      "HOST",
      "Expect",
      "expect",
    ])("rejects the hop-by-hop or framing header %s", (name) => {
      rejects({ [name]: "x" });
    });

    it("accepts names that only start like a blocked one", () => {
      const result = customHeadersSchema.safeParse({
        "X-Upgrade-Hint": "x",
        Tenant: "t",
      });
      expect(result.success).toBe(true);
    });

    it("rejects more than 10 custom headers", () => {
      rejects(
        Object.fromEntries(
          Array.from({ length: 11 }, (_, i) => [`X-Header-${i}`, `value-${i}`])
        )
      );
    });

    it("accepts exactly 10 custom headers", () => {
      const headers = Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`X-Header-${i}`, `value-${i}`])
      );
      expect(customHeadersSchema.safeParse(headers).success).toBe(true);
    });

    it("rejects invalid header name characters", () => {
      rejects({ "Invalid Header Name": "value" });
    });
  });

  describe("getWebhookEndpointsQuerySchema", () => {
    it.each([
      [
        "a NUL in filter[url]",
        { "filter[url]": "a\u0000", "filter[url_op]": "contains" },
      ],
      [
        "a NUL in filter[description]",
        {
          "filter[description]": "\u0000",
          "filter[description_op]": "contains",
        },
      ],
      [
        "a NUL in filter[eventType]",
        { "filter[eventType]": "\u0000", "filter[eventType_op]": "contains" },
      ],
      [
        "a filter value over 500 characters",
        { "filter[url]": "u".repeat(501), "filter[url_op]": "contains" },
      ],
      ["a non-boolean archived filter", { "filter[archived]": "maybe" }],
    ])("rejects %s", (_label, query) => {
      expect(getWebhookEndpointsQuerySchema.safeParse(query).success).toBe(
        false
      );
    });

    it("names the NUL in filter[url]", () => {
      const result = getWebhookEndpointsQuerySchema.safeParse({
        "filter[url]": "a\u0000",
        "filter[url_op]": "contains",
      });
      expect(result.error?.issues[0]).toMatchObject({
        path: ["filter[url]"],
        message: NUL,
      });
    });

    it("accepts a boolean archived filter", () => {
      const result = getWebhookEndpointsQuerySchema.safeParse({
        "filter[archived]": "true",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("listWebhookEndpointsExtraQuerySchema", () => {
    it("rejects a non-boolean archived filter", () => {
      const result = listWebhookEndpointsExtraQuerySchema.safeParse({
        "filter[archived]": "maybe",
      });
      expect(result.success).toBe(false);
    });
  });
});
