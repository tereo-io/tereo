// @module-tag unit
// @module-tag webhooks
import { updateWebhookEndpointSchema } from "../../../../../../routes/v1/webhooks/webhooks/webhook/schemas.js";
import { describe, it, expect } from "vitest";

describe("/v1/webhooks/webhooks/:id", () => {
  describe("updateWebhookEndpointSchema", () => {
    it.each([
      ["a NUL in the description", { description: "a\u0000" }],
      ["a NUL in an event type", { eventTypes: ["a\u0000"] }],
      [
        "a NUL in a custom header value",
        { customHeaders: { "X-A": "\u0000" } },
      ],
      [
        "a CRLF in a custom header value",
        { customHeaders: { "X-A": "a\r\nb" } },
      ],
      [
        "a character fetch cannot send in a custom header value",
        { customHeaders: { "X-A": "☃" } },
      ],
      [
        "more than 100 event types",
        { eventTypes: Array.from({ length: 101 }, (_, i) => `x.type-${i}`) },
      ],
      [
        "two header names that differ only in case",
        { customHeaders: { "X-Api-Key": "one", "x-api-key": "two" } },
      ],
      [
        "a reserved header name",
        { customHeaders: { "X-Webhook-Signature": "hack" } },
      ],
      [
        "more than 10 custom headers",
        {
          customHeaders: Object.fromEntries(
            Array.from({ length: 11 }, (_, i) => [`X-Header-${i}`, "v"])
          ),
        },
      ],
      [
        "an invalid header name character",
        { customHeaders: { "Invalid Header Name": "value" } },
      ],
      [
        "a custom header named expect, which fetch refuses to send",
        { customHeaders: { expect: "100-continue" } },
      ],
    ])("rejects %s", (_label, body) => {
      expect(updateWebhookEndpointSchema.safeParse(body).success).toBe(false);
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
    ])("rejects the hop-by-hop or framing header %s", (name) => {
      const body = { customHeaders: { [name]: "x" } };
      expect(updateWebhookEndpointSchema.safeParse(body).success).toBe(false);
    });

    it("accepts names that only start like a blocked one", () => {
      const body = { customHeaders: { "X-Upgrade-Hint": "x", Tenant: "t" } };
      expect(updateWebhookEndpointSchema.safeParse(body).success).toBe(true);
    });
  });
});
