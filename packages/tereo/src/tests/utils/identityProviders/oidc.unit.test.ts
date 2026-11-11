// @module-tag unit
// @module-tag auth
import type { IdentityProvider } from "../../../utils/identityProviders/types.js";
import { toIdentity } from "../../../utils/identityProviders/oidc.js";
import { describe, expect, it } from "vitest";

const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const OID = "00000000-0000-0000-66f3-3332eca7ea81";

const providerAt = (issuer: string) =>
  ({ id: "p", slug: "p", issuer }) as IdentityProvider;

const claims = {
  sub: "subject",
  iss: "ignored",
  aud: "client",
  iat: 0,
  exp: 0,
  oid: OID,
};

describe("toIdentity objectId", () => {
  it("is the oid claim for an Entra tenant issuer", () => {
    const provider = providerAt(
      `https://login.microsoftonline.com/${TENANT}/v2.0`
    );
    expect(toIdentity(provider, claims).objectId).toBe(OID);
  });

  it("is null when an Entra issuer sends no oid", () => {
    const provider = providerAt(
      `https://login.microsoftonline.com/${TENANT}/v2.0`
    );
    const { oid: _, ...withoutOid } = claims;
    expect(toIdentity(provider, withoutOid).objectId).toBeNull();
  });

  it.each([
    ["Google", "https://accounts.google.com"],
    ["Okta", "https://example.okta.com"],
    [
      "Entra's common endpoint",
      "https://login.microsoftonline.com/common/v2.0",
    ],
    ["Entra v1", `https://sts.windows.net/${TENANT}/`],
    [
      "an Entra look-alike host",
      `https://login.microsoftonline.com.evil.test/${TENANT}/v2.0`,
    ],
    [
      "an Entra issuer with a suffix",
      `https://login.microsoftonline.com/${TENANT}/v2.0/x`,
    ],
  ])("is null for %s even with an oid claim", (_, issuer) => {
    expect(toIdentity(providerAt(issuer), claims).objectId).toBeNull();
  });
});
