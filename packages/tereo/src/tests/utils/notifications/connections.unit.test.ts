// @module-tag unit
// @module-tag notifications
import type { NotificationConnection } from "../../../../prisma/generated/client/index.js";
import { toConnectionView } from "../../../utils/notifications/connections.js";
import { BadRequestError } from "../../../utils/errors.js";
import { describe, it, expect, afterEach } from "vitest";
import env from "../../../env.js";

describe("toConnectionView", () => {
  const original = env.ALLOW_PLAINTEXT_SMTP;
  afterEach(() => {
    env.ALLOW_PLAINTEXT_SMTP = original;
  });

  const settings = (security: string) => ({
    host: "smtp.acme.com",
    port: 25,
    security,
    defaultFrom: { address: "billing@acme.com" },
    allowedSenders: ["@acme.com"],
  });
  const stored = (security: string) =>
    ({
      id: "0192e9f0-0000-7000-8000-000000000002",
      slug: "plain",
      channel: "email",
      settings: settings(security),
    }) as unknown as NotificationConnection;

  it("turns a stored plaintext connection into 400 invalid_settings without the flag", () => {
    env.ALLOW_PLAINTEXT_SMTP = false;
    let thrown: unknown;
    try {
      toConnectionView(stored("none"));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BadRequestError);
    expect(thrown).toMatchObject({
      statusCode: 400,
      code: "invalid_settings",
    });

    env.ALLOW_PLAINTEXT_SMTP = true;
    expect(toConnectionView(stored("none")).settings).toMatchObject({
      security: "none",
    });
  });
});
