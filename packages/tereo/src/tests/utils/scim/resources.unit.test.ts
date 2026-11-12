// @module-tag unit
// @module-tag auth
import { ScimUserObjectSchema } from "../../../utils/scim/mapping.js";
import { describe, expect, it } from "vitest";
import {
  RESOURCES,
  resourceTypes,
  schemas,
  serviceProviderConfig,
} from "../../../utils/scim/resources.js";

interface Attr {
  name: string;
  subAttributes?: Attr[];
}

const userSchema = () => {
  const list = (
    schemas() as { Resources: Array<{ id: string; attributes: Attr[] }> }
  ).Resources;
  const found = list.find(
    (r) => r.id === "urn:ietf:params:scim:schemas:core:2.0:User"
  );
  if (!found) throw new Error("User schema missing");
  return found;
};

describe("resources", () => {
  it("lists User only", () => {
    expect(RESOURCES.map((r) => r.id)).toEqual(["User"]);
  });

  it("declares exactly the attributes the body schema accepts", () => {
    const declared = userSchema()
      .attributes.map((a) => a.name)
      .sort();
    expect(declared).toEqual(Object.keys(ScimUserObjectSchema.shape).sort());
  });

  it("declares the sub-attributes the body schema accepts", () => {
    const shape = ScimUserObjectSchema.shape;
    const subs = (name: string) =>
      userSchema()
        .attributes.find((a) => a.name === name)
        ?.subAttributes?.map((s) => s.name)
        .sort();
    expect(subs("name")).toEqual(
      Object.keys(shape.name.unwrap().unwrap().shape).sort()
    );
    expect(subs("emails")).toEqual(
      Object.keys(shape.emails.unwrap().unwrap().element.shape).sort()
    );
  });

  it("describes the User resource type", () => {
    const out = resourceTypes("https://core.test/scim/v2") as {
      Resources: Array<Record<string, unknown>>;
    };
    expect(out.Resources[0]).toMatchObject({
      id: "User",
      endpoint: "/Users",
      schema: "urn:ietf:params:scim:schemas:core:2.0:User",
    });
  });

  it("declares the capabilities", () => {
    const c = serviceProviderConfig("https://core.test/scim/v2");
    expect(c.patch.supported).toBe(true);
    expect(c.bulk.supported).toBe(false);
    expect(c.sort.supported).toBe(false);
    expect(c.etag.supported).toBe(false);
    expect(c.changePassword.supported).toBe(false);
    expect(c.filter).toEqual({ supported: true, maxResults: 200 });
    expect(c.authenticationSchemes[0]?.type).toBe("oauthbearertoken");
  });
});
