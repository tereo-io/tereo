// @module-tag unit
// @module-tag auth
import { oktaCreateUser } from "../../fixtures/scim/okta.js";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  listResponse,
  ScimUserBodySchema,
  toScimUser,
  toUserInput,
} from "../../../utils/scim/mapping.js";
import {
  entraCreateUser,
  entraUpnCreateUser,
} from "../../fixtures/scim/entra.js";

const input = (body: Record<string, unknown>) =>
  toUserInput(ScimUserBodySchema.parse(body));

describe("toUserInput", () => {
  it("prefers the primary email over the first", () => {
    expect(
      input({
        userName: "u",
        emails: [
          { value: "first@x.com" },
          { value: "Primary@x.com", primary: true },
        ],
      }).email
    ).toBe("primary@x.com");
  });

  it("falls back to the first email when none is primary", () => {
    expect(
      input({ userName: "u", emails: [{ value: "first@x.com" }] }).email
    ).toBe("first@x.com");
  });

  it("uses an email-shaped userName when there are no emails", () => {
    expect(input({ userName: "A@x.com" }).email).toBe("a@x.com");
  });

  it("requires emails when userName is not an email", () => {
    const result = ScimUserBodySchema.safeParse({ userName: "jdoe" });
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(ZodError);
    expect(result.error?.issues[0]?.path).toEqual(["emails"]);
  });

  it("accepts a UPN userName with an email", () => {
    const out = toUserInput(ScimUserBodySchema.parse(entraUpnCreateUser));
    expect(out.userName).toBe("jdoe");
    expect(out.email).toBe("jane.doe@example.com");
  });

  it.each([
    [{ displayName: "Display", name: { formatted: "Formatted" } }, "Display"],
    [{ name: { formatted: "Formatted", givenName: "G" } }, "Formatted"],
    [{ name: { givenName: "Given", familyName: "Family" } }, "Given Family"],
    [{ name: { givenName: "Given" } }, "Given"],
  ])("derives name from %j", (extra, expected) => {
    expect(input({ userName: "a@x.com", ...extra }).name).toBe(expected);
  });

  it("clears absent names (PUT semantics)", () => {
    expect(input({ userName: "a@x.com" })).toEqual({
      userName: "a@x.com",
      externalId: null,
      email: "a@x.com",
      firstName: null,
      lastName: null,
      name: null,
    });
  });

  it("maps the Okta and Entra create bodies", () => {
    expect(input(oktaCreateUser)).toMatchObject({
      email: "jane.doe@example.com",
      firstName: "Jane",
      lastName: "Doe",
      name: "Jane Doe",
      externalId: "00u1abcd2EFGH3ijk4l5",
      active: true,
    });
    expect(input({ ...entraCreateUser, active: "False" }).active).toBe(false);
  });

  it("refuses a 101-character givenName instead of clipping it", () => {
    const result = ScimUserBodySchema.safeParse({
      userName: "a@x.com",
      name: { givenName: "a".repeat(101) },
    });
    expect(result.success).toBe(false);
  });

  it("refuses a composed name over the column", () => {
    const result = ScimUserBodySchema.safeParse({
      userName: "a@x.com",
      name: { givenName: "a".repeat(60), familyName: "b".repeat(60) },
    });
    expect(result.error?.issues[0]?.path).toEqual(["name"]);
  });

  it("ignores unknown attributes and a password", () => {
    const out = input({ userName: "a@x.com", password: "p", title: "t" });
    expect(out).not.toHaveProperty("password");
  });
});

type UserRow = Parameters<typeof toScimUser>[0];
type ScimUserLink = Parameters<typeof toScimUser>[1];

describe("toScimUser", () => {
  const user = {
    id: "0198f2a4-0000-7000-8000-000000000001",
    email: "a@x.com",
    name: "A B",
    firstName: "A",
    lastName: "B",
    isActive: false,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-02T00:00:00Z"),
  } as UserRow;
  const link = {
    userName: "a@x.com",
    externalId: "ext",
  } as ScimUserLink;

  it("renders the resource", () => {
    const out = toScimUser(user, link, "https://core.test/scim/v2") as {
      schemas: string[];
      id: string;
      meta: { location: string };
      active: boolean;
      emails: Array<Record<string, unknown>>;
      externalId: string;
      name: Record<string, string>;
    };
    expect(out.schemas).toEqual(["urn:ietf:params:scim:schemas:core:2.0:User"]);
    expect(out.id).toBe(user.id);
    expect(out.meta.location).toBe(
      `https://core.test/scim/v2/Users/${user.id}`
    );
    expect(out.active).toBe(false);
    expect(out.emails[0]).toMatchObject({ value: "a@x.com", primary: true });
    expect(out.externalId).toBe("ext");
    expect(out.name).toEqual({
      formatted: "A B",
      givenName: "A",
      familyName: "B",
    });
  });
});

describe("listResponse", () => {
  it("reports the page and the total", () => {
    expect(listResponse([{}, {}], 7, 3)).toMatchObject({
      totalResults: 7,
      startIndex: 3,
      itemsPerPage: 2,
    });
  });
});
