// @module-tag unit
// @module-tag notifications
import { PermanentSendError } from "../../../../utils/notifications/channels/types.js";
import { emailAdapter } from "../../../../utils/notifications/channels/email.js";
import { describe, it, expect } from "vitest";

const content = (over: Record<string, unknown> = {}) => ({
  subject: "Invoice 1042",
  text: "Hello",
  ...over,
});

const paths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((i) => i.path.join("."));

describe("POST /v1/notifications", () => {
  describe("content checks", () => {
    it("refuses header injection in the subject", () => {
      const result = emailAdapter.contentSchema.safeParse(
        content({ subject: "Hi\r\nBcc: victim@example.com" })
      );
      expect(result.success).toBe(false);
      expect(paths(result)).toEqual(["subject"]);
    });

    it("refuses content with no body", () => {
      const result = emailAdapter.contentSchema.safeParse({ subject: "Hi" });
      expect(result.success).toBe(false);
    });

    it.each(["<", ">", "@", '"'])(
      "refuses a `from.name` containing %s",
      (char) => {
        const result = emailAdapter.contentSchema.safeParse(
          content({
            from: { address: "billing@acme.com", name: `ceo${char}bank.com` },
          })
        );
        expect(result.success).toBe(false);
        expect(paths(result)).toEqual(["from.name"]);
      }
    );
  });

  describe("recipient checks", () => {
    it("refuses an unknown recipient option", () => {
      const result = emailAdapter.recipientOptionsSchema.safeParse({
        As: "bcc",
      });
      expect(result.success).toBe(false);
    });

    it("refuses recipients with no `to`", () => {
      const only = (as: "cc" | "bcc") => [
        { address: "a@example.com", userId: null, options: { as } },
      ];
      for (const as of ["cc", "bcc"] as const) {
        let thrown: unknown;
        try {
          emailAdapter.plan(only(as));
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(PermanentSendError);
        expect(thrown).toMatchObject({ code: "invalid_content" });
      }
    });
  });
});
