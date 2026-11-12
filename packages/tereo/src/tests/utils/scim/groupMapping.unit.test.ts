// @module-tag unit
// @module-tag auth
import { entraCreateGroup } from "../../fixtures/scim/entra.js";
import { oktaCreateGroup } from "../../fixtures/scim/okta.js";
import { describe, expect, it } from "vitest";
import {
  GROUP_SCHEMA,
  memberValues,
  ScimGroupBodySchema,
  slugFromDisplayName,
  toGroupInput,
  toScimGroup,
  withSlugSuffix,
} from "../../../utils/scim/groupMapping.js";

describe("slugFromDisplayName", () => {
  it.each([
    ["Platform Engineering (EU)", "platform-engineering-eu"],
    ["  --Ops__Team--  ", "ops-team"],
    ["🎉🎉", "group"],
    ["日本語チーム", "group"],
    ["", "group"],
  ])("derives %j", (name, slug) => {
    expect(slugFromDisplayName(name)).toBe(slug);
  });

  it("cuts to 100 characters", () => {
    expect(slugFromDisplayName("a".repeat(255))).toHaveLength(100);
  });

  it("does not end on a dash after the cut", () => {
    const slug = slugFromDisplayName(`${"a".repeat(99)} b`);
    expect(slug).toBe("a".repeat(99));
  });
});

describe("withSlugSuffix", () => {
  it("appends the counter", () => {
    expect(withSlugSuffix("ops", 2)).toBe("ops-2");
  });

  it("cuts the base so the result fits in 100", () => {
    expect(withSlugSuffix("a".repeat(100), 12)).toMatch(/^a{97}-12$/);
  });
});

describe("memberValues", () => {
  it("deduplicates in first-seen order", () => {
    expect(
      memberValues([{ value: "u1" }, { value: "u1" }, { value: "u2" }])
    ).toEqual(["u1", "u2"]);
  });

  it.each([[[{ value: 7 }]], [[{}]], [["u1"]], ["u1"], [{ value: "u1" }]])(
    "rejects %j",
    (raw) => {
      expect(() => memberValues(raw)).toThrow(
        expect.objectContaining({ code: "invalidValue" })
      );
    }
  );
});

describe("ScimGroupBodySchema", () => {
  it("trims displayName", () => {
    const body = ScimGroupBodySchema.parse({ displayName: "  Ops  " });
    expect(toGroupInput(body)).toEqual({
      displayName: "Ops",
      externalId: null,
      members: [],
    });
  });

  it.each([["   "], [""], ["a".repeat(256)]])(
    "rejects displayName %j",
    (displayName) => {
      expect(ScimGroupBodySchema.safeParse({ displayName }).success).toBe(
        false
      );
    }
  );

  it("accepts 255 characters", () => {
    expect(
      ScimGroupBodySchema.safeParse({ displayName: "a".repeat(255) }).success
    ).toBe(true);
  });

  it("rejects a missing displayName and a long externalId", () => {
    expect(ScimGroupBodySchema.safeParse({}).success).toBe(false);
    expect(
      ScimGroupBodySchema.safeParse({
        displayName: "x",
        externalId: "a".repeat(256),
      }).success
    ).toBe(false);
  });

  it("turns a blank externalId into null", () => {
    const body = ScimGroupBodySchema.parse({
      displayName: "x",
      externalId: "  ",
    });
    expect(toGroupInput(body).externalId).toBeNull();
  });

  it.each([
    ["Okta", oktaCreateGroup],
    ["Entra", entraCreateGroup],
  ])("maps a %s create body", (_vendor, fixture) => {
    const input = toGroupInput(ScimGroupBodySchema.parse(fixture));
    expect(input).toEqual({
      displayName: "Platform Engineering",
      externalId: fixture.externalId,
      members: [
        "0198f2a4-0000-7000-8000-000000000001",
        "0198f2a4-0000-7000-8000-000000000002",
      ],
    });
  });

  it("rejects a non-string member value", () => {
    const body = ScimGroupBodySchema.parse({
      displayName: "x",
      members: [{ value: 5 }],
    });
    expect(() => toGroupInput(body)).toThrow(
      expect.objectContaining({ code: "invalidValue" })
    );
  });
});

describe("toScimGroup", () => {
  const now = new Date("2026-11-12T10:00:00.000Z");
  const view = {
    link: { externalId: "ext-1" },
    group: { id: "g1", name: "Ops", createdAt: now, updatedAt: now },
  } as unknown as Parameters<typeof toScimGroup>[0];

  it("omits members when none were loaded", () => {
    const out = toScimGroup(view, "https://core.test/scim/v2");
    expect(out).not.toHaveProperty("members");
    expect(out).toMatchObject({
      schemas: [GROUP_SCHEMA],
      id: "g1",
      externalId: "ext-1",
      displayName: "Ops",
      meta: {
        resourceType: "Group",
        created: now.toISOString(),
        lastModified: now.toISOString(),
        location: "https://core.test/scim/v2/Groups/g1",
      },
    });
  });

  it("lists members with display and $ref", () => {
    const out = toScimGroup(
      {
        ...view,
        members: [
          { id: "u1", name: "Jane" },
          { id: "u2", name: null },
        ],
      },
      "https://core.test/scim/v2"
    );
    expect(out.members).toEqual([
      {
        value: "u1",
        display: "Jane",
        $ref: "https://core.test/scim/v2/Users/u1",
      },
      {
        value: "u2",
        display: null,
        $ref: "https://core.test/scim/v2/Users/u2",
      },
    ]);
  });

  it("keeps an empty member list", () => {
    expect(toScimGroup({ ...view, members: [] }, "https://x").members).toEqual(
      []
    );
  });
});
