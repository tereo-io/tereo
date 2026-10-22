import type { NotificationConnection } from "../../../prisma/generated/client/index.js";
import { PermanentSendError } from "../../utils/notifications/channels/types.js";
import type { SendContext } from "../../utils/notifications/channels/types.js";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { toConnectionView } from "../../utils/notifications/connections.js";
import { emailAdapter } from "../../utils/notifications/channels/email.js";
import { BadRequestError } from "../../utils/errors.js";
import { Readable } from "stream";
import env from "../../env.js";
import {
  startFakeSmtpServer,
  type FakeSmtpServer,
} from "../support/fakeSmtpServer.js";

type Ctx = SendContext<
  Parameters<typeof emailAdapter.validate>[0]["settings"],
  { password?: string },
  Parameters<typeof emailAdapter.validate>[1]
>;

const buildCtx = (
  port: number,
  over: Partial<Ctx> = {},
  host = "127.0.0.1"
): Ctx => ({
  deliveryId: "0192e9f0-0000-7000-8000-000000000001",
  connection: {
    id: `conn-${port}`,
    slug: "main",
    channel: "email",
    settings: {
      host,
      port,
      security: "none",
      defaultFrom: { address: "billing@acme.com" },
      allowedSenders: ["@acme.com"],
    },
  },
  secrets: {},
  content: { subject: "Hello", text: "body" },
  recipients: [{ address: "to@x.com", userId: null, options: { as: "to" } }],
  attachments: [],
  ...over,
});

describe("email send", () => {
  const original = env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS;
  let smtp: FakeSmtpServer;
  let code = 250;

  beforeAll(async () => {
    env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = true;
    smtp = await startFakeSmtpServer({ reply: () => code });
  });
  afterEach(() => {
    code = 250;
    smtp.messages.length = 0;
  });
  afterAll(async () => {
    env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = original;
    await smtp.close();
  });

  it("delivers To/Cc without a Bcc header, with From, Reply-To and Message-ID", async () => {
    const ctx = buildCtx(smtp.port, {
      content: {
        subject: "Rechnung für März ✓",
        text: "Guten Tag",
        from: { address: "billing@acme.com", name: "Acme Billing" },
        replyTo: "support@acme.com",
      },
      recipients: [
        { address: "to@x.com", userId: null, options: { as: "to" } },
        { address: "cc@x.com", userId: null, options: { as: "cc" } },
        { address: "bcc@x.com", userId: null, options: { as: "bcc" } },
      ],
    });
    const result = await emailAdapter.send(ctx);

    expect(smtp.messages).toHaveLength(1);
    const [m] = smtp.messages;
    expect(m.parsed.subject).toBe("Rechnung für März ✓");
    expect(m.parsed.from?.value[0]).toMatchObject({
      address: "billing@acme.com",
      name: "Acme Billing",
    });
    expect(m.parsed.replyTo?.value[0].address).toBe("support@acme.com");
    expect(m.parsed.to).toMatchObject({ value: [{ address: "to@x.com" }] });
    expect(m.parsed.cc).toMatchObject({ value: [{ address: "cc@x.com" }] });
    expect(m.parsed.headers.has("bcc")).toBe(false);
    expect(m.rcpt.sort()).toEqual(["bcc@x.com", "cc@x.com", "to@x.com"]);
    expect(m.parsed.messageId).toBe(`<${ctx.deliveryId}@acme.com>`);
    expect(result.providerMessageId).toBe(`<${ctx.deliveryId}@acme.com>`);
  });

  it("sends attachments byte for byte", async () => {
    const a = Buffer.from([0, 1, 2, 250, 251, 252]);
    const b = Buffer.from("second attachment ✓");
    const att = (filename: string, contentType: string, data: Buffer) => ({
      filename,
      contentType,
      size: data.length,
      open: async () => Readable.from([data]),
    });
    await emailAdapter.send(
      buildCtx(smtp.port, {
        attachments: [
          att("a.bin", "application/octet-stream", a),
          att("b.txt", "text/plain", b),
        ],
      })
    );
    const files = smtp.messages[0].parsed.attachments;
    expect(files.map((f) => f.filename)).toEqual(["a.bin", "b.txt"]);
    expect(files[0].content.equals(a)).toBe(true);
    expect(files[1].content.equals(b)).toBe(true);
  });

  it("treats a 550 as permanent", async () => {
    code = 550;
    const err = await emailAdapter.send(buildCtx(smtp.port)).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentSendError);
    expect(err.code).toBe("smtp_rejected");
  });

  it("treats a 451 as retryable", async () => {
    code = 451;
    const err = await emailAdapter.send(buildCtx(smtp.port)).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentSendError);
  });

  it("refuses a private host unless the env flag is set", async () => {
    env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = false;
    try {
      const err = await emailAdapter.send(buildCtx(smtp.port)).catch((e) => e);
      expect(err).toBeInstanceOf(PermanentSendError);
      expect(err.code).toBe("host_not_allowed");
    } finally {
      env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = true;
    }
  });

  it("rebuilds the transport when the connection's settings change", async () => {
    const other = await startFakeSmtpServer();
    try {
      const ctx = buildCtx(smtp.port);
      await emailAdapter.send(ctx);
      ctx.connection = {
        ...ctx.connection,
        settings: { ...ctx.connection.settings, port: other.port },
      };
      await emailAdapter.send(ctx);
      expect(smtp.messages).toHaveLength(1);
      expect(other.messages).toHaveLength(1);
    } finally {
      await other.close();
    }
  });

  it("rebuilds the transport when only the password changes", async () => {
    const ctx = buildCtx(smtp.port);
    ctx.connection.settings = { ...ctx.connection.settings, username: "u" };
    ctx.secrets = { password: "old" };
    await emailAdapter.send(ctx);
    ctx.secrets = { password: "new" };
    await emailAdapter.send(ctx);
    expect(smtp.messages.map((m) => m.auth)).toEqual([
      { user: "u", pass: "old" },
      { user: "u", pass: "new" },
    ]);
  });

  it("test() sends one message to the given address", async () => {
    const ctx = buildCtx(smtp.port);
    await emailAdapter.test(ctx.connection, ctx.secrets, "me@x.com");
    expect(smtp.messages[0].rcpt).toEqual(["me@x.com"]);
  });

  describe("with private hosts refused", () => {
    beforeAll(() => {
      env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = false;
    });
    afterAll(() => {
      env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = true;
    });

    it("does not reveal the resolved address or host of a blocked host", async () => {
      const ctx = buildCtx(smtp.port, {}, "localhost");
      const err = await emailAdapter
        .test(ctx.connection, {}, "to@x.com")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PermanentSendError);
      expect((err as PermanentSendError).code).toBe("host_not_allowed");
      const message = (err as Error).message;
      expect(message).not.toContain("127.0.0.1");
      expect(message).not.toContain("::1");
      expect(message).not.toContain("localhost");
      expect(smtp.messages).toHaveLength(0);
    });

    it("collapses a DNS failure to a fixed, retryable message", async () => {
      const ctx = buildCtx(smtp.port, {}, "no-such-host.invalid");
      const err = await emailAdapter
        .test(ctx.connection, {}, "to@x.com")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(PermanentSendError);
      expect((err as Error).message).toBe("The SMTP host did not resolve");
    });
  });
});

describe("ALLOW_PLAINTEXT_SMTP", () => {
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

  it('refuses security "none" without the flag', () => {
    env.ALLOW_PLAINTEXT_SMTP = false;
    const parsed = emailAdapter.settingsSchema.safeParse(settings("none"));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.path.join("."))).toEqual([
      "security",
    ]);
    expect(
      emailAdapter.settingsSchema.safeParse(settings("starttls")).success
    ).toBe(true);
  });

  it('accepts security "none" with the flag', () => {
    env.ALLOW_PLAINTEXT_SMTP = true;
    expect(
      emailAdapter.settingsSchema.safeParse(settings("none")).success
    ).toBe(true);
  });

  it("turns a stored plaintext connection into 400 invalid_settings without the flag", () => {
    env.ALLOW_PLAINTEXT_SMTP = false;
    let thrown: unknown;
    try {
      toConnectionView(stored("none"));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BadRequestError);
    expect(thrown).toMatchObject({ statusCode: 400, code: "invalid_settings" });

    env.ALLOW_PLAINTEXT_SMTP = true;
    expect(toConnectionView(stored("none")).settings).toMatchObject({
      security: "none",
    });
  });
});
