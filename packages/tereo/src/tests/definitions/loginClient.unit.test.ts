// @module-tag unit
// @module-tag auth
import { describe, expect, it } from "vitest";
import {
  loginClientRedirectUris,
  LOGIN_CLIENT,
  skipsConsent,
} from "../../definitions/index.js";

const UI = "http://localhost:4000";

const CALLBACK = `${UI}/callback`;

const client = (
  consentRequired: boolean,
  trustedCoreScopes: string[] = []
) => ({ clientId: "app", consentRequired, trustedCoreScopes });

describe("loginClientRedirectUris", () => {
  it("is exactly the UI's callback in production", () => {
    expect(
      loginClientRedirectUris(
        ["http://localhost:4001/callback", "https://old.example/callback"],
        "https://core.example",
        true
      )
    ).toEqual(["https://core.example/callback"]);
  });

  it("adds the callback first and keeps other loopback ones outside production", () => {
    expect(
      loginClientRedirectUris(
        [
          "http://localhost:4001/callback",
          "http://127.0.0.1:4000/callback",
          "http://[::1]:4000/callback",
        ],
        UI,
        false
      )
    ).toEqual([
      CALLBACK,
      "http://localhost:4001/callback",
      "http://127.0.0.1:4000/callback",
      "http://[::1]:4000/callback",
    ]);
  });

  it("drops non-loopback callbacks outside production", () => {
    expect(
      loginClientRedirectUris(
        [
          "https://staging.example/callback",
          "http://localhost.evil.example/callback",
          "not a url",
        ],
        UI,
        false
      )
    ).toEqual([CALLBACK]);
  });

  it("does not repeat the callback", () => {
    expect(loginClientRedirectUris([CALLBACK, CALLBACK], UI, false)).toEqual([
      CALLBACK,
    ]);
  });
});

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
