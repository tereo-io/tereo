// @module-tag unit
// @module-tag auth
import { parseFilter } from "../../../utils/scim/filter.js";
import { describe, expect, it } from "vitest";

describe("parseFilter", () => {
  it("returns no clauses when absent", () => {
    expect(parseFilter(undefined)).toEqual([]);
  });

  it.each([
    ['userName eq "a@x.com"', [{ attr: "userName", value: "a@x.com" }]],
    ['USERNAME EQ "A@x.com"', [{ attr: "userName", value: "A@x.com" }]],
    ['emails.value eq "a@x.com"', [{ attr: "email", value: "a@x.com" }]],
    [
      'emails[type eq "work"].value eq "a@x.com"',
      [{ attr: "email", value: "a@x.com" }],
    ],
    [
      'externalId eq "abc" and userName eq "u"',
      [
        { attr: "externalId", value: "abc" },
        { attr: "userName", value: "u" },
      ],
    ],
    ['userName eq "o\\"b@x.com"', [{ attr: "userName", value: 'o"b@x.com' }]],
  ])("parses %s", (raw, expected) => {
    expect(parseFilter(raw)).toEqual(expected);
  });

  it.each([
    ['userName co "a"'],
    ["userName eq a"],
    ['a eq "b" or c eq "d"'],
    ['displayName eq "x"'],
    [""],
    [`userName eq "${"a".repeat(1995)}"`],
  ])("rejects %s", (raw) => {
    expect(() => parseFilter(raw)).toThrow(
      expect.objectContaining({ code: "invalidFilter" })
    );
  });

  it("accepts a filter of exactly 2000 characters", () => {
    const prefix = 'userName eq "';
    const raw = `${prefix}${"a".repeat(2000 - prefix.length - 1)}"`;
    expect(raw).toHaveLength(2000);
    expect(parseFilter(raw)).toHaveLength(1);
  });

  it("rejects a 2001-character filter", () => {
    const prefix = 'userName eq "';
    const raw = `${prefix}${"a".repeat(2001 - prefix.length - 1)}"`;
    expect(raw).toHaveLength(2001);
    expect(() => parseFilter(raw)).toThrow(
      expect.objectContaining({ code: "invalidFilter" })
    );
  });
});
