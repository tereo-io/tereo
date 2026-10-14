import type { AuditLogEntryInput } from "../types/audit.js";
import { validateEntry } from "../utils/auditSchemas.js";
import { computeChanges } from "../utils/audit.js";
import { describe, expect, it } from "vitest";

const base: AuditLogEntryInput = {
  userId: "ab60505d-7cda-4268-bcc9-074334915140",
  action: "CREATE",
  entityType: "Integration",
  entityId: "019eb2f1-f16f-75de-8d8b-bd549a47d8d8",
};

describe("validateEntry — change-diff shapes", () => {
  // Regression: under Zod 4, `z.object({ old: z.unknown(), new: z.unknown() })`
  // treats a missing key as invalid ("expected nonoptional"). computeChanges
  // emits `undefined` for the absent side and JSON serialization (outbox JSONB)
  // drops it, so CREATE/DELETE diffs arrive with one key missing. The schema
  // must accept that or every CREATE/DELETE audit dispatch fails on retry.
  it("accepts a CREATE diff carrying only `new`", () => {
    expect(() =>
      validateEntry({ ...base, changes: { isActive: { new: true } } })
    ).not.toThrow();
  });

  it("accepts a DELETE diff carrying only `old`", () => {
    expect(() =>
      validateEntry({
        ...base,
        action: "DELETE",
        changes: { isActive: { old: true } },
      })
    ).not.toThrow();
  });

  it("accepts an UPDATE diff carrying both sides", () => {
    expect(() =>
      validateEntry({ ...base, changes: { name: { old: "a", new: "b" } } })
    ).not.toThrow();
  });

  it("survives the outbox JSON round-trip that drops undefined `old`", () => {
    // Mirror the real path: computeChanges against {} (a CREATE), persisted to
    // and re-read from JSONB, then validated by the reaper before dispatch.
    const changes = computeChanges({}, { isActive: true, name: "USPS" });
    const roundTripped = JSON.parse(
      JSON.stringify({ ...base, changes })
    ) as AuditLogEntryInput;
    expect(roundTripped.changes).toEqual({
      isActive: { new: true },
      name: { new: "USPS" },
    });
    expect(() => validateEntry(roundTripped)).not.toThrow();
  });
});

describe("validateEntry — what core would refuse", () => {
  it("rejects an email core's validator rejects, and allows an empty one", () => {
    expect(() => validateEntry({ ...base, userEmail: "a@b" })).toThrow(
      /Invalid email/
    );
    expect(() => validateEntry({ ...base, userEmail: "" })).not.toThrow();
  });

  it("rejects a NUL character anywhere, keys of JSON included", () => {
    expect(() => validateEntry({ ...base, entityName: "a\u0000" })).toThrow(
      /NUL/
    );
    expect(() =>
      validateEntry({ ...base, metadata: { nested: ["x\u0000"] } })
    ).toThrow(/NUL/);
    expect(() =>
      validateEntry({ ...base, changes: { "a\u0000": { new: 1 } } })
    ).toThrow(/NUL/);
  });

  it("accepts an IPv4-mapped IPv6 address", () => {
    expect(() =>
      validateEntry({ ...base, ipAddress: "::ffff:127.0.0.1" })
    ).not.toThrow();
  });
});
