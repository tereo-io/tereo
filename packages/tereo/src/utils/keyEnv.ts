import { z } from "zod";

const isBase64Key = (value: string) =>
  Buffer.from(value, "base64").length === 32;

const base64Key = (name: string) =>
  z
    .string()
    .refine(isBase64Key, `${name} must decode to exactly 32 bytes of base64`)
    .optional();

/** Env for the keys `loadKeys()` (utils/keys.ts) stores in `core.secrets`. */
export const keyEnvFields = () => ({
  // Encrypts every value in `core.secrets` (AES-256-GCM). Required in
  // production; development and test fall back to a fixed, public dev KEK.
  CORE_KEK: base64Key("CORE_KEK"),
  // The KEK being rotated out: rows under it are re-encrypted under CORE_KEK
  // on start. Remove it once every process has started with the new one.
  CORE_KEK_PREVIOUS: base64Key("CORE_KEK_PREVIOUS"),
  // HMAC key for authorization codes. Generated when unset.
  AUTH_CODE_HMAC_KEY: base64Key("AUTH_CODE_HMAC_KEY"),
});

const KEK_REQUIRED_MESSAGE =
  "CORE_KEK is required in production: a base64-encoded 32-byte key that " +
  "encrypts the keys core stores in core.secrets (generate one with " +
  "`openssl rand -base64 32` and keep it outside the database)";

export const refineKeyEnv = (
  env: { NODE_ENV: string; CORE_KEK?: string; CORE_KEK_PREVIOUS?: string },
  ctx: z.RefinementCtx
): void => {
  // Without CORE_KEK the previous KEK's rows would be re-wrapped under the
  // public dev KEK.
  if (env.CORE_KEK_PREVIOUS && !env.CORE_KEK) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["CORE_KEK_PREVIOUS"],
      message: "CORE_KEK_PREVIOUS needs CORE_KEK: the KEK to re-encrypt under",
    });
  }
  if (env.NODE_ENV === "production" && !env.CORE_KEK) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["CORE_KEK"],
      message: KEK_REQUIRED_MESSAGE,
    });
  }
};
