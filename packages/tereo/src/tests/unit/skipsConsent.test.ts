import { LOGIN_CLIENT, skipsConsent } from "../../definitions/index.js";
import { describe, expect, it } from "vitest";

const client = (
  consentRequired: boolean,
  trustedCoreScopes: string[] = []
) => ({ clientId: "app", consentRequired, trustedCoreScopes });

describe("skipsConsent", () => {
  it("always skips for core's own client", () => {
    expect(
      skipsConsent(
        {
          clientId: LOGIN_CLIENT.clientId,
          consentRequired: true,
          trustedCoreScopes: [],
        },
        ["openid", "core:admin"]
      )
    ).toBe(true);
  });

  it("skips for a consentRequired:false client asking for no core scope", () => {
    expect(skipsConsent(client(false), ["openid", "profile"])).toBe(true);
  });

  it("skips for a consentRequired:false client asking only for trusted core scopes", () => {
    expect(
      skipsConsent(client(false, ["core:files.read", "core:account"]), [
        "openid",
        "core:files.read",
      ])
    ).toBe(true);
  });

  it("asks when a requested core scope is not trusted", () => {
    expect(
      skipsConsent(client(false, ["core:files.read"]), [
        "openid",
        "core:files.read",
        "core:audit.read",
      ])
    ).toBe(false);
  });

  it("asks for a consentRequired:true client, whatever it trusts", () => {
    expect(
      skipsConsent(client(true, ["core:files.read"]), [
        "openid",
        "core:files.read",
      ])
    ).toBe(false);
    expect(skipsConsent(client(true), ["openid"])).toBe(false);
  });

  it("never skips for prompt=consent, except for core's own client", () => {
    expect(skipsConsent(client(false), ["openid"], "consent")).toBe(false);
    expect(skipsConsent(client(false), ["openid"], "login consent")).toBe(
      false
    );
    expect(
      skipsConsent(
        {
          clientId: LOGIN_CLIENT.clientId,
          consentRequired: true,
          trustedCoreScopes: [],
        },
        ["openid"],
        "consent"
      )
    ).toBe(true);
  });
});
