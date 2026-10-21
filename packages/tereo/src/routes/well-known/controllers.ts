import { publishedSigningKeys } from "../../utils/keys.js";
import { CORE_SCOPES } from "../../definitions/index.js";
import { OAuth2Error } from "../../utils/errors.js";
import { type Request, Response } from "express";
import { createPublicKey } from "crypto";
import env from "../../env.js";

export const handleWellKnownOAuth = async (_req: Request, res: Response) => {
  const baseUrl = env.ISSUER;
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    introspection_endpoint: `${baseUrl}/oauth/introspect`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    jwks_uri: `${baseUrl}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: [
      "authorization_code",
      "client_credentials",
      "refresh_token",
    ],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
    introspection_endpoint_auth_methods_supported: ["client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
    code_challenge_methods_supported: ["S256"],
    // RFC 9207: every authorization response carries `iss`.
    authorization_response_iss_parameter_supported: true,
  });
};

export const handleOpenIdConfiguration = async (
  _req: Request,
  res: Response
) => {
  const baseUrl = env.ISSUER;
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    userinfo_endpoint: `${baseUrl}/oauth/userinfo`,
    end_session_endpoint: `${baseUrl}/oauth/end-session`,
    jwks_uri: `${baseUrl}/.well-known/jwks.json`,
    introspection_endpoint: `${baseUrl}/oauth/introspect`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      "client_credentials",
    ],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
    introspection_endpoint_auth_methods_supported: ["client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
    // Discovery defaults request_uri_parameter_supported to true.
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
    scopes_supported: [
      "openid",
      "profile",
      "email",
      "offline_access",
      ...CORE_SCOPES.map((s) => s.name),
    ],
    claims_supported: [
      "sub",
      "iss",
      "aud",
      "exp",
      "iat",
      "auth_time",
      "nonce",
      "at_hash",
      "acr",
      "amr",
      "name",
      "given_name",
      "family_name",
      "email",
      "email_verified",
      "picture",
      "updated_at",
      "org_id",
      "sid",
    ],
    acr_values_supported: ["urn:auth-service:pwd", "urn:auth-service:mfa"],
    prompt_values_supported: ["none", "login", "consent"],
    code_challenge_methods_supported: ["S256"],
    // RFC 9207: every authorization response carries `iss`.
    authorization_response_iss_parameter_supported: true,
  });
};

/**
 * The active signing key and any retired one still within its retention
 * (utils/keys.ts), so tokens signed before a rotation keep verifying.
 */
export const handleWellKnownJwks = async (_req: Request, res: Response) => {
  try {
    const keys = publishedSigningKeys().map(({ kid, publicKey }) => ({
      ...createPublicKey(publicKey).export({ format: "jwk" }),
      use: "sig",
      alg: "RS256",
      kid,
    }));

    res.json({ keys });
  } catch {
    throw new OAuth2Error("server_error", "Failed to generate JWKS", 500);
  }
};
