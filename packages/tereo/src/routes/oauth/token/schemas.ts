import { redirectUriSchema } from "../schemas.js";
import { z } from "zod";
import {
  MAX_CLIENT_ID_LENGTH,
  MAX_CODE_VERIFIER_LENGTH,
  MAX_SCOPE_LENGTH,
  MAX_TOKEN_LENGTH,
} from "../utils.js";

const MIN_CODE_VERIFIER_LENGTH = 43;
const MAX_CODE_LENGTH = 128;
// RFC 7636 section 4.1: unreserved characters only.
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]+$/;

const RefreshTokenResponseModeEnum = z.enum(["body", "cookie"]);

export type RefreshTokenResponseMode = z.infer<
  typeof RefreshTokenResponseModeEnum
>;

// Loose schema for initial grant_type validation - allows any grant_type string
// so we can return proper RFC-compliant error codes
export const TokenRequestSchemaLoose = z.object({
  grant_type: z.string().min(1),
  client_id: z.string().max(MAX_CLIENT_ID_LENGTH).optional(),
  code: z.string().max(MAX_CODE_LENGTH).optional(),
  redirect_uri: z.string().optional(),
  code_verifier: z.string().max(MAX_CODE_VERIFIER_LENGTH).optional(),
  refresh_token: z.string().max(MAX_TOKEN_LENGTH).optional(),
  scope: z.string().max(MAX_SCOPE_LENGTH).optional(),
  refresh_token_response_mode: RefreshTokenResponseModeEnum.optional(),
});

export type TokenRequestLoose = z.infer<typeof TokenRequestSchemaLoose>;

export const TokenRequestSchema = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("client_credentials"),
    scope: z.string().max(MAX_SCOPE_LENGTH).optional(),
    client_id: z.string().max(MAX_CLIENT_ID_LENGTH).optional(),
  }),
  z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string().min(1).max(MAX_CODE_LENGTH),
    redirect_uri: redirectUriSchema,
    // code_verifier is optional at schema level; validated in handler for RFC 7636 compliance
    code_verifier: z
      .string()
      .min(MIN_CODE_VERIFIER_LENGTH)
      .max(MAX_CODE_VERIFIER_LENGTH)
      .regex(CODE_VERIFIER_PATTERN)
      .optional(),
    client_id: z.string().max(MAX_CLIENT_ID_LENGTH).optional(),
    refresh_token_response_mode: RefreshTokenResponseModeEnum.optional(),
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string().max(MAX_TOKEN_LENGTH).optional(),
    scope: z.string().max(MAX_SCOPE_LENGTH).optional(),
    client_id: z.string().max(MAX_CLIENT_ID_LENGTH).optional(),
    refresh_token_response_mode: RefreshTokenResponseModeEnum.optional(),
  }),
]);

export type TokenRequest = z.infer<typeof TokenRequestSchema>;
