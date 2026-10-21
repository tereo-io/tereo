import { z } from "zod";

// Maximum storage quota: 1 Terabyte (prevents BigInt overflow)
const MAX_STORAGE_QUOTA = BigInt(1024 * 1024 * 1024 * 1024);

// Values are written into response headers as they are, so each must be a
// valid origin (`scheme://host[:port]`, or `*`) or an RFC 9110 token.
const ORIGIN =
  /^[a-z][a-z0-9+.-]*:\/\/(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const originSchema = z
  .string()
  .max(255)
  .refine((v) => v === "*" || ORIGIN.test(v), {
    message: "Must be an origin (scheme://host[:port]) or '*'",
  });
const headerNameSchema = z
  .string()
  .max(255)
  .regex(TOKEN, "Must be a header name (RFC 9110 token)");

const corsConfigSchema = z
  .object({
    allowedOrigins: z.array(originSchema).min(1).max(50),
    allowedMethods: z
      .array(z.enum(["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH"]))
      .min(1)
      .max(6)
      .default(["GET", "HEAD"]),
    allowedHeaders: z
      .array(headerNameSchema)
      .max(20)
      .default(["Content-Type", "Authorization"]),
    exposedHeaders: z.array(headerNameSchema).max(20).optional(),
    maxAgeSeconds: z.coerce.number().int().min(0).max(86400).default(600),
    allowCredentials: z.boolean().default(false),
  })
  .refine(
    (cfg) => !(cfg.allowCredentials && cfg.allowedOrigins.includes("*")),
    {
      // Per RFC 9110 §10.3.1, `Access-Control-Allow-Credentials: true` cannot
      // pair with a wildcard origin. The middleware echoes the request Origin
      // back rather than `*`, so the response itself is technically compliant —
      // but the *config* "any origin can use credentials" is a CSRF footgun
      // that no caller should be opting into. Reject up front.
      path: ["allowCredentials"],
      message:
        "allowCredentials cannot be true when allowedOrigins includes '*' (set explicit origins instead)",
    }
  );

const rateLimitConfigSchema = z
  .object({
    tokensPerSecond: z.coerce.number().positive().max(10_000),
    maxTokens: z.coerce.number().int().positive().max(100_000),
    requestCost: z.coerce.number().positive().default(1),
  })
  .refine((cfg) => cfg.requestCost <= cfg.maxTokens, {
    // The bucket never holds more than maxTokens, so a dearer request is
    // refused forever.
    path: ["requestCost"],
    message: "requestCost cannot exceed maxTokens",
  });

export const updateBucketSchema = z.object({
  description: z.string().max(500).optional(),
  policy: z.enum(["public", "private"]).optional(),
  // Null clears the quota, as on create.
  storageQuotaBytes: z
    .union([
      z.coerce
        .bigint()
        .positive()
        .max(MAX_STORAGE_QUOTA, "Storage quota exceeds maximum allowed (1 TB)"),
      z.null(),
    ])
    .optional(),
  versioningEnabled: z.boolean().optional(),
  autoThumbnails: z.boolean().optional(),
  corsConfig: corsConfigSchema.nullable().optional(),
  rateLimitConfig: rateLimitConfigSchema.nullable().optional(),
});

export type UpdateBucketInput = z.infer<typeof updateBucketSchema>;
export type CorsConfig = z.infer<typeof corsConfigSchema>;
export type RateLimitConfig = z.infer<typeof rateLimitConfigSchema>;
