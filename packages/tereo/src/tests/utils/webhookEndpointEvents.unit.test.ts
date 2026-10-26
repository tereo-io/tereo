// @module-tag unit
// @module-tag webhooks
import { redactWebhookUrl } from "../../utils/webhookEndpointEvents.js";
import { describe, it, expect } from "vitest";

describe("redactWebhookUrl", () => {
  it("keeps only the origin, as capability URLs carry their secret in the path", () => {
    expect(
      redactWebhookUrl("https://hooks.slack.com/services/T000/B000/SECRET")
    ).toBe("https://hooks.slack.com");
    expect(
      redactWebhookUrl(
        "https://user:pass@hooks.example.com:8443/a/SECRET?token=SECRET#SECRET"
      )
    ).toBe("https://hooks.example.com:8443");
    expect(redactWebhookUrl("not a url")).toBe("[invalid url]");
  });
});
