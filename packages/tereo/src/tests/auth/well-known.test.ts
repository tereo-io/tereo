import { BASE_URL, HTTP_STATUS } from "./utils/test-helpers.js";
import { describe, it, expect } from "vitest";

interface OIDCConfig {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
  response_types_supported?: string[];
  grant_types_supported?: string[];
  scopes_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  claims_supported?: string[];
  code_challenge_methods_supported?: string[];
  end_session_endpoint?: string;
  revocation_endpoint?: string;
  introspection_endpoint?: string;
  subject_types_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
  acr_values_supported?: string[];
  prompt_values_supported?: string[];
  [key: string]: unknown;
}

interface JWKS {
  keys: Array<{
    kty?: string;
    use?: string;
    kid?: string;
    alg?: string;
    n?: string;
    e?: string;
    [key: string]: unknown;
  }>;
}

interface HealthResponse {
  status?: string;
  [key: string]: unknown;
}

describe("Well-Known Endpoints", () => {
  describe("GET /.well-known/openid-configuration", () => {
    it("should return 200 with OpenID Connect discovery document", async () => {
      const response = await fetch(
        `${BASE_URL}/.well-known/openid-configuration`
      );
      const config = (await response.json()) as OIDCConfig;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.headers.get("content-type")).toContain(
        "application/json"
      );
      expect(config).toBeDefined();
    });

    it("should include required OIDC fields per OpenID Connect Discovery 1.0", async () => {
      const response = await fetch(
        `${BASE_URL}/.well-known/openid-configuration`
      );
      const config = (await response.json()) as OIDCConfig;

      expect(response.status).toBe(HTTP_STATUS.OK);

      // Required fields per OIDC Discovery 1.0 Section 3
      expect(config.issuer).toBeDefined();
      expect(typeof config.issuer).toBe("string");
      // Note: OIDC spec requires issuer to be a URL (https://...)
      // In test environments, issuer may be configured as a simple identifier
      // Production deployments MUST use a URL format
      expect(config.issuer?.length).toBeGreaterThan(0);

      expect(config.authorization_endpoint).toBeDefined();
      expect(typeof config.authorization_endpoint).toBe("string");
      expect(config.authorization_endpoint).toContain("/oauth/authorize");

      expect(config.token_endpoint).toBeDefined();
      expect(typeof config.token_endpoint).toBe("string");
      expect(config.token_endpoint).toContain("/oauth/token");

      expect(config.userinfo_endpoint).toBeDefined();
      expect(typeof config.userinfo_endpoint).toBe("string");
      expect(config.userinfo_endpoint).toContain("/oauth/userinfo");

      expect(config.jwks_uri).toBeDefined();
      expect(typeof config.jwks_uri).toBe("string");
      expect(config.jwks_uri).toContain("/.well-known/jwks.json");

      // Required arrays
      expect(config.response_types_supported).toBeDefined();
      expect(Array.isArray(config.response_types_supported)).toBe(true);

      expect(config.subject_types_supported).toBeDefined();
      expect(Array.isArray(config.subject_types_supported)).toBe(true);

      expect(config.id_token_signing_alg_values_supported).toBeDefined();
      expect(Array.isArray(config.id_token_signing_alg_values_supported)).toBe(
        true
      );
    });

    it("should include supported response types including 'code'", async () => {
      const response = await fetch(
        `${BASE_URL}/.well-known/openid-configuration`
      );
      const config = (await response.json()) as OIDCConfig;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(config.response_types_supported).toBeDefined();
      expect(config.response_types_supported).toContain("code");
    });

    it("should include supported grant types", async () => {
      const response = await fetch(
        `${BASE_URL}/.well-known/openid-configuration`
      );
      const config = (await response.json()) as OIDCConfig;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(config.grant_types_supported).toBeDefined();
      expect(config.grant_types_supported).toContain("authorization_code");
      expect(config.grant_types_supported).toContain("refresh_token");
      expect(config.grant_types_supported).toContain("client_credentials");
    });

    it("should include supported scopes including openid, profile, email", async () => {
      const response = await fetch(
        `${BASE_URL}/.well-known/openid-configuration`
      );
      const config = (await response.json()) as OIDCConfig;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(config.scopes_supported).toBeDefined();
      expect(config.scopes_supported).toContain("openid");
      expect(config.scopes_supported).toContain("profile");
      expect(config.scopes_supported).toContain("email");
      expect(config.scopes_supported).toContain("offline_access");
    });

    it("should include token endpoint auth methods", async () => {
      const response = await fetch(
        `${BASE_URL}/.well-known/openid-configuration`
      );
      const config = (await response.json()) as OIDCConfig;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(config.token_endpoint_auth_methods_supported).toBeDefined();
      expect(Array.isArray(config.token_endpoint_auth_methods_supported)).toBe(
        true
      );
      // Basic auth for confidential clients, none (PKCE) for public ones; a
      // client_secret in the body is not accepted.
      expect(config.token_endpoint_auth_methods_supported).toEqual([
        "client_secret_basic",
        "none",
      ]);
    });

    it("should include supported claims including required OIDC claims", async () => {
      const response = await fetch(
        `${BASE_URL}/.well-known/openid-configuration`
      );
      const config = (await response.json()) as OIDCConfig;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(config.claims_supported).toBeDefined();
      // Required ID token claims
      expect(config.claims_supported).toContain("sub");
      expect(config.claims_supported).toContain("iss");
      expect(config.claims_supported).toContain("aud");
      expect(config.claims_supported).toContain("exp");
      expect(config.claims_supported).toContain("iat");
      // Standard claims
      expect(config.claims_supported).toContain("name");
      expect(config.claims_supported).toContain("email");
    });

    it("should include code challenge methods for PKCE with S256", async () => {
      const response = await fetch(
        `${BASE_URL}/.well-known/openid-configuration`
      );
      const config = (await response.json()) as OIDCConfig;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(config.code_challenge_methods_supported).toBeDefined();
      expect(config.code_challenge_methods_supported).toContain("S256");
      // Should NOT support plain (insecure)
      expect(config.code_challenge_methods_supported).not.toContain("plain");
    });

    it("should include end_session_endpoint for logout", async () => {
      const response = await fetch(
        `${BASE_URL}/.well-known/openid-configuration`
      );
      const config = (await response.json()) as OIDCConfig;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(config.end_session_endpoint).toBeDefined();
      expect(typeof config.end_session_endpoint).toBe("string");
      expect(config.end_session_endpoint).toContain("/oauth/end-session");
    });

    it("should include revocation_endpoint for token revocation", async () => {
      const response = await fetch(
        `${BASE_URL}/.well-known/openid-configuration`
      );
      const config = (await response.json()) as OIDCConfig;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(config.revocation_endpoint).toBeDefined();
      expect(typeof config.revocation_endpoint).toBe("string");
      expect(config.revocation_endpoint).toContain("/oauth/revoke");
    });

    it("should include introspection_endpoint for token introspection", async () => {
      const response = await fetch(
        `${BASE_URL}/.well-known/openid-configuration`
      );
      const config = (await response.json()) as OIDCConfig;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(config.introspection_endpoint).toBeDefined();
      expect(typeof config.introspection_endpoint).toBe("string");
      expect(config.introspection_endpoint).toContain("/oauth/introspect");
    });

    it("should include acr_values_supported for authentication context", async () => {
      const response = await fetch(
        `${BASE_URL}/.well-known/openid-configuration`
      );
      const config = (await response.json()) as OIDCConfig;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(config.acr_values_supported).toBeDefined();
      expect(Array.isArray(config.acr_values_supported)).toBe(true);
      expect(config.acr_values_supported).toContain("urn:auth-service:pwd");
      expect(config.acr_values_supported).toContain("urn:auth-service:mfa");
    });

    it("should include prompt_values_supported for UI prompts", async () => {
      const response = await fetch(
        `${BASE_URL}/.well-known/openid-configuration`
      );
      const config = (await response.json()) as OIDCConfig;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(config.prompt_values_supported).toBeDefined();
      expect(Array.isArray(config.prompt_values_supported)).toBe(true);
      expect(config.prompt_values_supported).toContain("none");
      expect(config.prompt_values_supported).toContain("login");
      expect(config.prompt_values_supported).toContain("consent");
    });
  });

  describe("GET /.well-known/oauth-authorization-server", () => {
    it("should return 200 with OAuth 2.0 authorization server metadata", async () => {
      const response = await fetch(
        `${BASE_URL}/.well-known/oauth-authorization-server`
      );
      const config = (await response.json()) as OIDCConfig;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.headers.get("content-type")).toContain(
        "application/json"
      );
      expect(config.issuer).toBeDefined();
      expect(config.authorization_endpoint).toBeDefined();
      expect(config.token_endpoint).toBeDefined();
    });

    it("should include required OAuth 2.0 metadata fields", async () => {
      const response = await fetch(
        `${BASE_URL}/.well-known/oauth-authorization-server`
      );
      const config = (await response.json()) as OIDCConfig;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(config.issuer).toBeDefined();
      expect(config.authorization_endpoint).toBeDefined();
      expect(config.token_endpoint).toBeDefined();
      expect(config.response_types_supported).toBeDefined();
      expect(config.grant_types_supported).toBeDefined();
    });

    it("should advertise the same token endpoint auth methods as OIDC discovery", async () => {
      const [oauth, oidc] = await Promise.all(
        [
          `${BASE_URL}/.well-known/oauth-authorization-server`,
          `${BASE_URL}/.well-known/openid-configuration`,
        ].map(async (url) => (await (await fetch(url)).json()) as OIDCConfig)
      );

      expect(oauth.token_endpoint_auth_methods_supported).toEqual(
        oidc.token_endpoint_auth_methods_supported
      );
    });
  });

  describe("GET /.well-known/jwks.json", () => {
    it("should return 200 with JSON Web Key Set", async () => {
      const response = await fetch(`${BASE_URL}/.well-known/jwks.json`);
      const jwks = (await response.json()) as JWKS;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(response.headers.get("content-type")).toContain(
        "application/json"
      );
      expect(jwks.keys).toBeDefined();
      expect(Array.isArray(jwks.keys)).toBe(true);
    });

    it("should include at least one signing key", async () => {
      const response = await fetch(`${BASE_URL}/.well-known/jwks.json`);
      const jwks = (await response.json()) as JWKS;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(jwks.keys.length).toBeGreaterThan(0);
    });

    it("should include required JWK fields per RFC 7517", async () => {
      const response = await fetch(`${BASE_URL}/.well-known/jwks.json`);
      const jwks = (await response.json()) as JWKS;

      expect(response.status).toBe(HTTP_STATUS.OK);
      const key = jwks.keys[0];

      // Required fields
      expect(key.kty).toBe("RSA");
      expect(key.use).toBe("sig");
      expect(key.kid).toBeDefined();
      expect(typeof key.kid).toBe("string");
      expect(key.alg).toBe("RS256");
    });

    it("should include RSA public key components (n and e)", async () => {
      const response = await fetch(`${BASE_URL}/.well-known/jwks.json`);
      const jwks = (await response.json()) as JWKS;

      expect(response.status).toBe(HTTP_STATUS.OK);
      const key = jwks.keys[0];

      // RSA public key components per RFC 7518
      expect(key.n).toBeDefined(); // modulus
      expect(typeof key.n).toBe("string");
      expect(key.n!.length).toBeGreaterThan(100); // RSA keys have long modulus

      expect(key.e).toBeDefined(); // exponent
      expect(typeof key.e).toBe("string");
      expect(key.e).toBe("AQAB"); // Standard public exponent 65537 in base64url
    });

    it("should NOT include private key components", async () => {
      const response = await fetch(`${BASE_URL}/.well-known/jwks.json`);
      const jwks = (await response.json()) as JWKS;

      expect(response.status).toBe(HTTP_STATUS.OK);
      const key = jwks.keys[0];

      // Private key components must NOT be present
      expect(key).not.toHaveProperty("d"); // private exponent
      expect(key).not.toHaveProperty("p"); // first prime factor
      expect(key).not.toHaveProperty("q"); // second prime factor
      expect(key).not.toHaveProperty("dp"); // first factor CRT exponent
      expect(key).not.toHaveProperty("dq"); // second factor CRT exponent
      expect(key).not.toHaveProperty("qi"); // first CRT coefficient
    });
  });

  describe("GET /health", () => {
    it("should return 200 with health status", async () => {
      const response = await fetch(`${BASE_URL}/health`);
      const data = (await response.json()) as HealthResponse;

      expect(response.status).toBe(HTTP_STATUS.OK);
      expect(data.status).toBe("ok");
    });
  });
});
