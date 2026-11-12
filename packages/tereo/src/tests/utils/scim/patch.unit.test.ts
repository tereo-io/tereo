// @module-tag unit
// @module-tag auth
import { applyPatch, ScimPatchBodySchema } from "../../../utils/scim/patch.js";
import { describe, expect, it } from "vitest";
import {
  entraAttributePatch,
  entraDeactivatePatch,
} from "../../fixtures/scim/entra.js";
import {
  oktaAttributePatch,
  oktaDeactivatePatch,
} from "../../fixtures/scim/okta.js";

const patch = (...Operations: Array<Record<string, unknown>>) =>
  applyPatch(ScimPatchBodySchema.parse({ Operations }));

describe("applyPatch", () => {
  it.each(["Replace", "ADD", "replace"])("accepts op %s", (op) => {
    expect(patch({ op, path: "externalId", value: "x" })).toEqual({
      externalId: "x",
    });
  });

  it("applies an Okta value object without a path", () => {
    expect(applyPatch(ScimPatchBodySchema.parse(oktaDeactivatePatch))).toEqual({
      active: false,
    });
  });

  it("applies an Okta attribute patch with dotted keys", () => {
    expect(applyPatch(ScimPatchBodySchema.parse(oktaAttributePatch))).toEqual({
      name: "Jane Q. Doe",
      firstName: "Janet",
    });
  });

  it("reads Entra's string booleans", () => {
    expect(applyPatch(ScimPatchBodySchema.parse(entraDeactivatePatch))).toEqual(
      { active: false }
    );
  });

  it("applies an Entra attribute patch", () => {
    expect(applyPatch(ScimPatchBodySchema.parse(entraAttributePatch))).toEqual({
      firstName: "Janet",
      lastName: "Roe",
      email: "janet.roe@example.com",
      externalId: "new-external-id",
    });
  });

  it("maps name.givenName to firstName", () => {
    expect(
      patch({ op: "replace", path: "name.givenName", value: "A" })
    ).toEqual({ firstName: "A" });
  });

  it("maps a filtered emails path to email", () => {
    expect(
      patch({
        op: "replace",
        path: 'emails[type eq "work"].value',
        value: "A@X.com",
      })
    ).toEqual({ email: "a@x.com" });
  });

  it.each([
    ["emails.value", "A@X.com"],
    ['emails[type eq "work"].value', "A@X.com"],
    ['EMAILS[TYPE EQ "Work"].VALUE', "A@X.com"],
    ["emails[primary eq true].value", "A@X.com"],
    ["emails[primary eq True].value", "A@X.com"],
    ["urn:ietf:params:scim:schemas:core:2.0:User:emails.value", "A@X.com"],
  ])("writes the core email from %s", (path, value) => {
    expect(patch({ op: "replace", path, value })).toEqual({
      email: "a@x.com",
    });
  });

  it.each([
    'emails[type eq "home"].value',
    'emails[type eq "other"].value',
    "emails[primary eq false].value",
    'emails[value eq "a@x.com"].value',
    'emails[type eq "work"]',
    'emails[type eq "work" and primary eq true].value',
  ])("ignores %s like an unknown attribute", (path) => {
    expect(
      patch({ op: "replace", path, value: "home@elsewhere.test" })
    ).toEqual({});
    expect(patch({ op: "remove", path })).toEqual({});
  });

  it.each(["emails", 'emails[type eq "work"].value'])(
    "refuses to remove %s",
    (path) => {
      expect(() => patch({ op: "remove", path })).toThrow(
        expect.objectContaining({ code: "invalidValue" })
      );
    }
  );

  it("deactivates with Entra's home email in the same body, ignoring the email", () => {
    expect(
      patch(
        { op: "Replace", path: "active", value: "False" },
        {
          op: "Add",
          path: 'emails[type eq "home"].value',
          value: "someone@personal.test",
        }
      )
    ).toEqual({ active: false });
  });

  it("takes the primary address from an emails array", () => {
    expect(
      patch({
        op: "replace",
        path: "emails",
        value: [{ value: "a@x.com" }, { value: "b@x.com", primary: true }],
      })
    ).toEqual({ email: "b@x.com" });
  });

  it("clears a name attribute on remove", () => {
    expect(patch({ op: "remove", path: "name.familyName" })).toEqual({
      lastName: null,
    });
  });

  it.each(["userName", "active"])("refuses to remove %s", (path) => {
    expect(() => patch({ op: "remove", path })).toThrow(
      expect.objectContaining({ code: "invalidValue" })
    );
  });

  it("refuses remove without a path", () => {
    expect(() => patch({ op: "remove" })).toThrow(
      expect.objectContaining({ code: "invalidPath" })
    );
  });

  it.each(["title", "password"])("ignores the %s path", (path) => {
    expect(patch({ op: "replace", path, value: "x" })).toEqual({});
  });

  it("rejects the whole body when a later op is unsupported", () => {
    expect(() =>
      patch(
        { op: "replace", path: "active", value: false },
        { op: "move", path: "active" }
      )
    ).toThrow(expect.objectContaining({ code: "invalidSyntax" }));
  });

  it("refuses a value longer than its column", () => {
    expect(() =>
      patch({ op: "replace", path: "name.givenName", value: "a".repeat(101) })
    ).toThrow(expect.objectContaining({ code: "invalidValue" }));
  });

  it.each([
    ["name.givenName", "firstName"],
    ["name.familyName", "lastName"],
    ["name.formatted", "name"],
    ["displayName", "name"],
    ["externalId", "externalId"],
  ])("clears %s on a blank value, as PUT does", (path, key) => {
    for (const value of ["", "   ", null]) {
      expect(patch({ op: "replace", path, value })).toEqual({ [key]: null });
    }
  });

  it("clears blank sub-attributes of a name object", () => {
    expect(
      patch({
        op: "replace",
        path: "name",
        value: { givenName: " ", familyName: "Roe" },
      })
    ).toEqual({ firstName: null, lastName: "Roe" });
  });

  it("keeps a non-blank value as given", () => {
    expect(
      patch({ op: "replace", path: "name.givenName", value: " Ann " })
    ).toEqual({ firstName: " Ann " });
  });

  it.each(["name.familyName", "name.formatted", "displayName", "externalId"])(
    "refuses an over-long %s",
    (path) => {
      expect(() =>
        patch({ op: "replace", path, value: "a".repeat(256) })
      ).toThrow(expect.objectContaining({ code: "invalidValue" }));
    }
  );

  it("refuses an over-long blank-padded value rather than clearing it", () => {
    expect(() =>
      patch({ op: "replace", path: "name.givenName", value: " ".repeat(101) })
    ).toThrow(expect.objectContaining({ code: "invalidValue" }));
  });

  it("refuses a non-boolean active", () => {
    expect(() =>
      patch({ op: "replace", path: "active", value: "maybe" })
    ).toThrow(expect.objectContaining({ code: "invalidValue" }));
  });

  it.each(["", "   "])("refuses an empty userName %j", (value) => {
    expect(() => patch({ op: "replace", path: "userName", value })).toThrow(
      expect.objectContaining({ code: "invalidValue" })
    );
  });
});
