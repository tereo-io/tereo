import { emailSchema } from "../../../utils/email.js";
import { redirectUriSchema } from "../schemas.js";
import { z } from "zod";
import {
  MAX_CLIENT_ID_LENGTH,
  MAX_SCOPE_LENGTH,
  MIN_CODE_CHALLENGE_LENGTH,
} from "../utils.js";

const MAX_STATE_LENGTH = 512;
const MAX_NONCE_LENGTH = 512;
const MAX_PASSWORD_LENGTH = 256;
const MAX_ACR_VALUES_LENGTH = 512;
const MAX_CLAIMS_LENGTH = 4096;
const MAX_LOGIN_HINT_LENGTH = 256;
const MAX_UI_LOCALES_LENGTH = 128;

const SUPPORTED_RESPONSE_MODES = ["query"] as const;

// RFC 7636 section 4.2: an S256 challenge is the unpadded base64url of a
// SHA-256 digest — always 43 characters.
const codeChallengeSchema = z
  .string()
  .length(MIN_CODE_CHALLENGE_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, "code_challenge must be base64url");

const claimsSchema = z
  .string()
  .max(MAX_CLAIMS_LENGTH)
  .optional()
  .refine(
    (val) => {
      if (!val) return true;
      try {
        JSON.parse(val);
        return true;
      } catch {
        return false;
      }
    },
    { message: "claims parameter must be valid JSON" }
  );

const responseModeSchema = z
  .string()
  .max(32)
  .optional()
  .refine(
    (val) => {
      if (!val) return true;
      return SUPPORTED_RESPONSE_MODES.includes(
        val as (typeof SUPPORTED_RESPONSE_MODES)[number]
      );
    },
    { message: "Unsupported response_mode" }
  );

// select_account is accepted and ignored (there is one account per
// browser), so it is not advertised in discovery.
const PROMPT_VALUES = ["none", "login", "consent", "select_account"];

// OIDC Core 3.1.2.1: a space-delimited list; `none` must stand alone.
const promptSchema = z
  .string()
  .max(64)
  .optional()
  .superRefine((val, ctx) => {
    if (val === undefined) return;
    const values = val.split(" ");
    const unknown = values.filter((v) => !PROMPT_VALUES.includes(v));
    if (unknown.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `Unsupported prompt value(s): ${unknown.join(", ") || "(empty)"}`,
      });
    } else if (values.includes("none") && values.length > 1) {
      ctx.addIssue({
        code: "custom",
        message: "prompt=none cannot be combined with other values",
      });
    }
  });

/** Whether a validated `prompt` list includes `value`. */
export const hasPrompt = (
  prompt: string | null | undefined,
  value: "none" | "login" | "consent"
): boolean => !!prompt && prompt.split(" ").includes(value);

export const AuthorizeRequestSchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1).max(MAX_CLIENT_ID_LENGTH),
  redirect_uri: redirectUriSchema,
  scope: z.string().max(MAX_SCOPE_LENGTH).optional(),
  state: z.string().min(1).max(MAX_STATE_LENGTH),
  nonce: z.string().max(MAX_NONCE_LENGTH).optional(),
  code_challenge: codeChallengeSchema,
  code_challenge_method: z.literal("S256"),
  max_age: z.coerce.number().int().min(0).optional(),
  acr_values: z.string().max(MAX_ACR_VALUES_LENGTH).optional(),
  prompt: promptSchema,
  claims: claimsSchema,
  response_mode: responseModeSchema,
  login_hint: z.string().max(MAX_LOGIN_HINT_LENGTH).optional(),
  ui_locales: z.string().max(MAX_UI_LOCALES_LENGTH).optional(),
  org_id: z.guid().optional(),
});

export const AuthorizeSubmitSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  client_id: z.string().min(1).max(MAX_CLIENT_ID_LENGTH),
  redirect_uri: redirectUriSchema,
  scope: z.string().max(MAX_SCOPE_LENGTH).optional(),
  state: z.string().min(1).max(MAX_STATE_LENGTH),
  nonce: z.string().max(MAX_NONCE_LENGTH).optional(),
  code_challenge: codeChallengeSchema,
  code_challenge_method: z.literal("S256"),
  max_age: z.coerce.number().int().min(0).optional(),
  acr_values: z.string().max(MAX_ACR_VALUES_LENGTH).optional(),
  prompt: promptSchema,
});

export type AuthorizeRequest = z.infer<typeof AuthorizeRequestSchema>;
export type AuthorizeSubmit = z.infer<typeof AuthorizeSubmitSchema>;
