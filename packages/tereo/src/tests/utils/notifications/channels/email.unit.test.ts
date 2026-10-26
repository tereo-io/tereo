// @module-tag unit
// @module-tag notifications
import { PermanentSendError } from "../../../../utils/notifications/channels/types.js";
import { emailAdapter } from "../../../../utils/notifications/channels/email.js";
import type { User } from "../../../../../prisma/generated/client/index.js";
import { BadRequestError } from "../../../../utils/errors.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import { logger } from "../../../../utils/logger.js";
import env from "../../../../env.js";

const settings = {
  host: "smtp.acme.com",
  port: 587,
  security: "starttls" as const,
  defaultFrom: { address: "billing@acme.com", name: "Acme" },
  allowedSenders: ["@acme.com"],
};

describe("emailAdapter", () => {
  describe("email contentSchema", () => {
    const ok = { subject: "Hi", text: "body" };
    const parse = (c: unknown) => emailAdapter.contentSchema.safeParse(c);

    it("accepts text or html", () => {
      expect(parse(ok).success).toBe(true);
      expect(parse({ subject: "Hi", html: "<p>x</p>" }).success).toBe(true);
    });
    it.each(["a\r\nBcc: x@evil.com", "a\nb", "a\rb"])(
      "refuses CR/LF in the subject (%j)",
      (subject) => {
        expect(parse({ ...ok, subject }).success).toBe(false);
      }
    );
    it("refuses CR/LF in from.name and replyTo", () => {
      expect(
        parse({ ...ok, from: { address: "a@acme.com", name: "A\r\nX: y" } })
          .success
      ).toBe(false);
      expect(
        parse({ ...ok, replyTo: "a@acme.com\r\nBcc: x@evil.com" }).success
      ).toBe(false);
    });
    it("refuses neither text nor html", () => {
      expect(parse({ subject: "Hi" }).success).toBe(false);
    });
    it("refuses a 999-character subject and takes 998", () => {
      expect(parse({ ...ok, subject: "a".repeat(999) }).success).toBe(false);
      expect(parse({ ...ok, subject: "a".repeat(998) }).success).toBe(true);
    });
  });

  describe("email settingsSchema", () => {
    afterEach(() => vi.unstubAllEnvs());
    const parse = (s: unknown) => emailAdapter.settingsSchema.safeParse(s);

    it("accepts valid settings", () => {
      expect(parse(settings).success).toBe(true);
    });
    it("refuses a defaultFrom outside allowedSenders", () => {
      expect(
        parse({ ...settings, allowedSenders: ["@other.com"] }).success
      ).toBe(false);
    });
    it('refuses security "none" unless ALLOW_PLAINTEXT_SMTP is set', () => {
      const original = env.ALLOW_PLAINTEXT_SMTP;
      try {
        env.ALLOW_PLAINTEXT_SMTP = true;
        expect(parse({ ...settings, security: "none" }).success).toBe(true);
        env.ALLOW_PLAINTEXT_SMTP = false;
        expect(parse({ ...settings, security: "none" }).success).toBe(false);
        expect(parse(settings).success).toBe(true);
      } finally {
        env.ALLOW_PLAINTEXT_SMTP = original;
      }
    });
  });

  describe("email plan", () => {
    const r = (address: string, as?: "to" | "cc" | "bcc", userId = null) => ({
      address,
      userId,
      options: { as: as ?? ("to" as const) },
    });

    it("makes one delivery for any recipients", () => {
      const plan = emailAdapter.plan([r("a@x.com"), r("b@x.com", "cc")]);
      expect(plan).toHaveLength(1);
      expect(plan[0].recipients).toHaveLength(2);
    });
    it("collapses duplicates case-insensitively, keeping the highest of to > cc > bcc", () => {
      const [d] = emailAdapter.plan([
        r("A@x.com", "bcc"),
        r("a@x.com", "to"),
        r("b@x.com", "bcc"),
        r("B@x.com", "cc"),
        r("c@x.com", "cc"),
      ]);
      const byAddress = Object.fromEntries(
        d.recipients.map((x) => [x.address.toLowerCase(), x.options.as])
      );
      expect(d.recipients).toHaveLength(3);
      expect(byAddress).toEqual({
        "a@x.com": "to",
        "b@x.com": "cc",
        "c@x.com": "cc",
      });
    });
    it("throws invalid_content without a to recipient", () => {
      expect(() => emailAdapter.plan([r("a@x.com", "cc")])).toThrow(
        PermanentSendError
      );
      expect(() => emailAdapter.plan([r("a@x.com", "bcc")])).toThrow(
        expect.objectContaining({ code: "invalid_content" })
      );
    });
  });

  describe("email summarize", () => {
    it("is the subject", () => {
      expect(
        emailAdapter.summarize({ subject: "Invoice 1042", text: "x" })
      ).toBe("Invoice 1042");
    });
  });

  describe("email validate", () => {
    const conn = {
      id: "c1",
      slug: "main",
      channel: "email" as const,
      settings,
    };

    it("refuses a from outside the allowed senders", () => {
      try {
        emailAdapter.validate(conn, {
          subject: "s",
          text: "t",
          from: { address: "a@other.com" },
        });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestError);
        expect((e as BadRequestError).code).toBe("sender_not_allowed");
      }
    });
    it("accepts an allowed from and an absent from", () => {
      expect(() =>
        emailAdapter.validate(conn, {
          subject: "s",
          text: "t",
          from: { address: "x@acme.com" },
        })
      ).not.toThrow();
      expect(() =>
        emailAdapter.validate(conn, { subject: "s", text: "t" })
      ).not.toThrow();
    });
  });

  describe("email resolveUser", () => {
    const user = (o: Partial<User>) =>
      ({
        email: "p@x.com",
        isActive: true,
        userType: "human",
        ...o,
      }) as User;

    it("returns the address of an active human", () => {
      expect(emailAdapter.resolveUser(user({}))).toBe("p@x.com");
    });
    it("returns null for inactive users and service accounts", () => {
      expect(emailAdapter.resolveUser(user({ isActive: false }))).toBeNull();
      expect(
        emailAdapter.resolveUser(user({ userType: "service_account" }))
      ).toBeNull();
    });
  });

  describe("email send", () => {
    const allowPrivateHosts = env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS;

    afterEach(() => {
      env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = allowPrivateHosts;
      vi.restoreAllMocks();
    });

    it("logs why an SMTP host did not resolve, then throws a generic error", async () => {
      env.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS = false;
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      const connectionId = crypto.randomUUID();

      await expect(
        emailAdapter.test(
          {
            id: connectionId,
            slug: "nowhere",
            channel: "email",
            settings: { ...settings, host: "no-such-host.invalid" },
          },
          {},
          "a@example.com"
        )
      ).rejects.toThrow("The SMTP host did not resolve");
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), connectionId }),
        "SMTP host did not resolve"
      );
    });
  });
});
