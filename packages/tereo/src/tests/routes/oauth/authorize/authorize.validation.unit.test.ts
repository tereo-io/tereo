// @module-tag unit
// @module-tag auth
import { describe, it, expect } from "vitest";
import {
  AuthorizeRequestSchema,
  AuthorizeSubmitSchema,
} from "../../../../routes/oauth/authorize/schemas.js";

// A well-formed S256 challenge: 43 base64url characters.
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const request = {
  response_type: "code",
  client_id: "test-client",
  redirect_uri: "http://localhost:3000/callback",
  state: "test-state",
  scope: "openid",
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
};

const submit = {
  ...request,
  email: "user@test.local",
  password: "SomePassword123!",
};

describe("GET /oauth/authorize", () => {
  describe("AuthorizeRequestSchema", () => {
    it.each([
      ["max_age=0", { max_age: "0" }],
      [
        "space-separated acr_values",
        { acr_values: "urn:auth-service:mfa urn:auth-service:pwd" },
      ],
      ["prompt=select_account", { prompt: "select_account" }],
      ["a space-separated prompt list", { prompt: "login consent" }],
      ["a login_hint", { login_hint: "test-oidc-user@test.local" }],
      ["an email as login_hint", { login_hint: "user@example.com" }],
      ["ui_locales", { ui_locales: "en" }],
      ["space-separated ui_locales", { ui_locales: "en es fr" }],
      [
        "claims with userinfo claims",
        {
          claims: JSON.stringify({
            userinfo: { name: { essential: true }, email: { essential: true } },
          }),
        },
      ],
      [
        "claims with id_token claims",
        {
          claims: JSON.stringify({
            id_token: {
              auth_time: { essential: true },
              acr: { values: ["urn:auth-service:mfa"] },
            },
          }),
        },
      ],
      [
        "several OIDC parameters together",
        {
          nonce: "a-nonce",
          prompt: "login",
          max_age: "3600",
          ui_locales: "en",
          acr_values: "urn:auth-service:pwd",
          login_hint: "user@example.com",
        },
      ],
      ["response_mode=query", { response_mode: "query" }],
      [
        "an RFC-variant-0 org_id",
        { org_id: "00000000-0000-7002-0000-000000000001" },
      ],
    ])("accepts %s", (_label, overrides) => {
      expect(
        AuthorizeRequestSchema.safeParse({ ...request, ...overrides }).success
      ).toBe(true);
    });

    it.each([
      [
        "a missing code_challenge",
        { code_challenge: undefined },
        "code_challenge",
      ],
      [
        "code_challenge_method=plain",
        { code_challenge_method: "plain" },
        "code_challenge_method",
      ],
      [
        "a code_challenge longer than an S256 digest",
        { code_challenge: "a".repeat(44) },
        "code_challenge",
      ],
      [
        "a code_challenge that is not base64url",
        { code_challenge: "+".repeat(43) },
        "code_challenge",
      ],
      ["a negative max_age", { max_age: "-1" }, "max_age"],
      ["a max_age past int4", { max_age: "99999999999" }, "max_age"],
      ["malformed claims JSON", { claims: "not-valid-json" }, "claims"],
      [
        "an unsupported response_mode",
        { response_mode: "invalid_mode" },
        "response_mode",
      ],
      [
        "prompt=none combined with another value",
        { prompt: "none login" },
        "prompt",
      ],
      [
        "an unknown value in a prompt list",
        { prompt: "login bogus" },
        "prompt",
      ],
      ["an unknown prompt value", { prompt: "invalid_value" }, "prompt"],
      ["an uppercase prompt value", { prompt: "NONE" }, "prompt"],
    ])("rejects %s", (_label, overrides, field) => {
      const result = AuthorizeRequestSchema.safeParse({
        ...request,
        ...overrides,
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].path).toEqual([field]);
    });
  });
});

describe("POST /oauth/authorize", () => {
  describe("AuthorizeSubmitSchema", () => {
    it.each([["an empty password", { password: "" }, "password"]])(
      "rejects %s",
      (_label, overrides, field) => {
        const result = AuthorizeSubmitSchema.safeParse({
          ...submit,
          ...overrides,
        });
        expect(result.success).toBe(false);
        expect(result.error?.issues[0].path).toEqual([field]);
      }
    );
  });
});
