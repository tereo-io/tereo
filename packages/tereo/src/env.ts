import "./preload.js";
import { DEFAULT_UI_DIST_PATH, resolveUiBaseUrl } from "./utils/ui.js";
import { redisEnvFields, refineRedisEnv } from "./utils/redisEnv.js";
import { cursorSigningEnvFields } from "./utils/cursorSigner.js";
import { keyEnvFields, refineKeyEnv } from "./utils/keyEnv.js";
import path from "path";
import { z } from "zod";

// The one env schema for the whole service.
//
// Values are read from the real environment (and `.env` via preload). There is
// no topology resolver any more: nothing rewrites URLs per runtime context, so
// local and test runs set DATABASE_URL / REDIS_URL explicitly.

function readSecret(envVar: string, decode = false): string | undefined {
  const value = process.env[envVar];
  if (value && decode) return Buffer.from(value, "base64").toString("utf-8");
  return value;
}

const corsOrigins = z.string().transform((val) =>
  val === "*"
    ? ("*" as const)
    : val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
);

// Keys are optional here: `loadKeys()` (utils/keys.ts) fills any that env
// leaves unset from `core.secrets`, generating them on first start.
const isBase64Key = (value: string) =>
  Buffer.from(value, "base64").length === 32;

const SIGNING_KEY_PREFIXES = ["CURSOR", "FILE_SERVICE"] as const;
const SIGNING_KEY_NAME = new RegExp(
  `^(${SIGNING_KEY_PREFIXES.join("|")})_SIGNING_KEY_V[1-9][0-9]*$`
);

/** `CURSOR_SIGNING_KEY_V{n}` and `FILE_SERVICE_SIGNING_KEY_V{n}`, any n. */
type SigningKeys = Partial<
  Record<
    `${(typeof SIGNING_KEY_PREFIXES)[number]}_SIGNING_KEY_V${number}`,
    string
  >
>;

/**
 * The environment as the schema reads it. An empty value is unset, so its
 * default applies: `FOO=` in a .env, or compose's `FOO: ${FOO}` with FOO
 * unset, must not coerce to 0 or "". Signing keys are versioned without
 * bound, so they are gathered by name into `SIGNING_KEYS`.
 */
const prepareEnv = (input: unknown): unknown => {
  if (typeof input !== "object" || input === null) return input;
  const entries = Object.entries(input).filter(([, value]) => value !== "");
  return {
    ...Object.fromEntries(entries),
    SIGNING_KEYS: Object.fromEntries(
      entries.filter(([name]) => SIGNING_KEY_NAME.test(name))
    ),
  };
};

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

/** An integer setting within [min, max]: a duration, a count or a port. */
const int = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const bool = (fallback: "true" | "false") =>
  z
    .string()
    .default(fallback)
    .transform((val) => val === "true" || val === "1");

/**
 * `COOKIE_SECURE` as set, or else on in production and off elsewhere (plain
 * http on localhost in development and tests).
 */
export const resolveCookieSecure = (
  value: string | undefined,
  nodeEnv: string | undefined
): boolean =>
  value === undefined || value === ""
    ? nodeEnv === "production"
    : value === "true" || value === "1";

const DEV_PUBLIC_URL = "http://localhost:4001";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Why `COOKIE_SECURE` is unusable, or undefined if it is fine. Production
 * cookies carry sessions and login state, so they are never sent over http.
 */
export const checkCookieSecure = (
  value: string | undefined,
  nodeEnv: string | undefined
): string | undefined =>
  nodeEnv === "production" && !resolveCookieSecure(value, nodeEnv)
    ? "COOKIE_SECURE cannot be turned off in production"
    : undefined;

/**
 * Why `PUBLIC_URL` is unusable, or undefined if it is fine. In production it
 * must be set, to https, and to an address other machines can reach: the
 * issuer, share links and redirects are all built from it.
 */
export const checkPublicUrl = (
  value: string | undefined,
  nodeEnv: string | undefined
): string | undefined => {
  if (nodeEnv !== "production") return undefined;
  if (!value) return "PUBLIC_URL is required in production";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined; // z.string().url() reports it.
  }
  if (LOOPBACK_HOSTS.has(url.hostname)) {
    return "PUBLIC_URL must be a public URL in production, not localhost";
  }
  return url.protocol === "https:"
    ? undefined
    : "PUBLIC_URL must be an https:// URL in production";
};

/**
 * Why `UI_BASE_URL` is unusable, or undefined if it is fine. Unset, it is
 * `PUBLIC_URL`, which checkPublicUrl covers; set, it must be https in
 * production, since the login client's redirect URI is built from it.
 */
export const checkUiBaseUrl = (
  value: string | undefined,
  nodeEnv: string | undefined
): string | undefined => {
  if (nodeEnv !== "production" || !value) return undefined;
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    return undefined; // z.string().url() reports it.
  }
  return protocol === "https:"
    ? undefined
    : "UI_BASE_URL must be an https:// URL in production";
};

/**
 * Why `ISSUER` is unusable, or undefined if it is fine. It is compared
 * exactly by every client (the `iss` claim, discovery, RFC 9207's `iss`), so
 * it is a URL without query or fragment, https in production.
 */
export const checkIssuer = (
  value: string | undefined,
  nodeEnv: string | undefined
): string | undefined => {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "ISSUER must be a URL";
  }
  if (url.search || url.hash || value.includes("#") || value.includes("?")) {
    return "ISSUER must not have a query or fragment";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "ISSUER must be an http(s) URL";
  }
  return nodeEnv === "production" && url.protocol !== "https:"
    ? "ISSUER must be an https:// URL in production"
    : undefined;
};

/**
 * Why `CORS_ALLOWED_ORIGINS` is unusable, or undefined if it is fine. The
 * listed origins are sent credentialed CORS headers, so in production an
 * http one (which anyone on its network can impersonate) is refused, except
 * on loopback.
 */
export const checkCorsOrigins = (
  value: string[] | "*" | undefined,
  nodeEnv: string | undefined
): string | undefined => {
  if (nodeEnv !== "production" || value === undefined) return undefined;
  if (value === "*") {
    return "CORS_ALLOWED_ORIGINS must be explicitly configured in production (cannot use '*')";
  }
  const insecure = value.filter((origin) => {
    try {
      const url = new URL(origin);
      return url.protocol !== "https:" && !LOOPBACK_HOSTS.has(url.hostname);
    } catch {
      return true;
    }
  });
  return insecure.length > 0
    ? `CORS_ALLOWED_ORIGINS must list https:// origins in production: ${insecure.join(", ")}`
    : undefined;
};

/**
 * Settings that still point at the paths core served before its API moved
 * under `/v1` and the admin UI to `/`, or use a variable since renamed.
 * None has an alias, so they break quietly: file links 404, UI redirects land
 * on the app shell, and a provisioning file is never read.
 */
export const stalePathWarnings = (source: {
  FILE_SERVICE_PUBLIC_BASE_URL?: string;
  UI_BASE_URL?: string;
  PROVISIONING_FILE?: string;
  PROVISIONING_PATH?: string;
}): string[] => {
  const pathOf = (url: string | undefined) => {
    if (!url) return undefined;
    try {
      return new URL(url).pathname.replace(/\/+$/, "");
    } catch {
      return undefined;
    }
  };
  const warnings: string[] = [];
  const filesPath = pathOf(source.FILE_SERVICE_PUBLIC_BASE_URL);
  if (filesPath?.endsWith("/files") && !filesPath.endsWith("/v1/files")) {
    warnings.push(
      "FILE_SERVICE_PUBLIC_BASE_URL ends in /files; core serves files at /v1/files (the default is ${PUBLIC_URL}/v1/files)"
    );
  }
  if (pathOf(source.UI_BASE_URL)?.endsWith("/ui")) {
    warnings.push(
      "UI_BASE_URL ends in /ui; core serves the admin UI at / (the default is PUBLIC_URL in production)"
    );
  }
  if (source.PROVISIONING_FILE && !source.PROVISIONING_PATH) {
    warnings.push(
      "PROVISIONING_FILE is no longer read; set PROVISIONING_PATH to a JSON provisioning document or a folder of them"
    );
  }
  return warnings;
};

const DEFAULT_TRUST_PROXY = "loopback";

/**
 * Why `TRUST_PROXY` is unusable, or undefined if it is fine. In production it
 * must be set: behind a load balancer the loopback default makes `req.ip` the
 * proxy's address, so every client shares one rate-limit key and audit IP.
 * `true` is refused there: it trusts every X-Forwarded-For hop, so a client
 * picks its own `req.ip`.
 */
export const checkTrustProxy = (
  value: string | undefined,
  nodeEnv: string | undefined
): string | undefined => {
  if (nodeEnv !== "production") return undefined;
  if (!value) {
    return "TRUST_PROXY must be set in production (the proxies in front of core: a hop count, a CIDR list, or 'loopback'/'false' when there are none)";
  }
  return value.trim().toLowerCase() === "true"
    ? "TRUST_PROXY cannot be 'true' in production (it lets clients choose their IP): use a hop count, a CIDR list, 'loopback' or 'false'"
    : undefined;
};

/**
 * Why `OIDC_ALLOW_PRIVATE_ISSUERS` is unusable, or undefined if it is fine. It
 * turns off the SSRF guard on admin-typed issuer URLs, so never in production.
 */
export const checkOidcAllowPrivateIssuers = (
  value: boolean,
  nodeEnv: string | undefined
): string | undefined =>
  nodeEnv === "production" && value
    ? "OIDC_ALLOW_PRIVATE_ISSUERS cannot be set in production"
    : undefined;

const EnvFields = z
  .object({
    // -------------------------------------------------------------------------
    // Process
    // -------------------------------------------------------------------------
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    // `all` runs HTTP and background work in one process; `api` and `worker`
    // split them so each can be scaled on its own.
    ROLE: z.enum(["all", "api", "worker"]).default("all"),
    PORT: int(1, 65535, 4001),
    // ROLE=worker serves no API; it answers GET /health on this port instead.
    WORKER_HEALTH_PORT: int(0, 65535, 4002),
    // Externally reachable base URL of this service. Defaults derived from it:
    // ISSUER, FILE_SERVICE_PUBLIC_BASE_URL and, in production, UI_BASE_URL.
    // Required in production; http://localhost:4001 otherwise.
    PUBLIC_URL: z.string().url().optional(),
    DATABASE_URL: z.string(),
    ...redisEnvFields(),
    // Express `trust proxy` setting. Controls how `req.ip` is resolved from
    // X-Forwarded-For. Without this, the credential/TOTP failure limiters and
    // the share-unlock limiter key on a client-supplied header value, so an
    // attacker can rotate it per request to dodge lockout.
    //
    // Accepts:
    //   - "loopback" (default in non-prod) — trust 127.0.0.1, ::1
    //   - "linklocal" / "uniquelocal" — Express named ranges
    //   - a hop count: "1", "2" — number of trusted proxies in front
    //   - a comma-separated list of trusted IPs / CIDRs
    //   - "true" / "false" — trust everything / nothing
    // Required in production, where "true" is refused (see checkTrustProxy);
    // "loopback" otherwise.
    TRUST_PROXY: z.string().optional(),
    // Defaults to UI_BASE_URL's origin outside production.
    CORS_ALLOWED_ORIGINS: corsOrigins.optional(),
    // HMAC key(s) for the opaque cursors every list endpoint returns
    // (CURSOR_SIGNING_KEY_V{n}).
    ...cursorSigningEnvFields("CURSOR"),
    // CORE_KEK (wraps core.secrets) and AUTH_CODE_HMAC_KEY.
    ...keyEnvFields(),

    // -------------------------------------------------------------------------
    // auth
    // -------------------------------------------------------------------------
    // PEM (base64-encoded in env). Generated when unset — see loadKeys().
    JWT_PRIVATE_KEY: z.string().min(32).optional(),
    JWT_PUBLIC_KEY: z.string().min(32).optional(),
    // Defaults to the public key's JWK thumbprint.
    JWT_KEY_ID: z.string().optional(),
    JWT_ACCESS_TOKEN_TTL: int(1, DAY, 3600),
    // Absolute lifetime of a refresh-token family, from the code exchange;
    // rotation keeps the family's original expiry.
    JWT_REFRESH_TOKEN_TTL: int(1, 365 * DAY, 30 * DAY),
    // Absolute lifetime of the SSO session (prompt=none and org switching
    // without a password), from the login that started it.
    USER_SESSION_TTL: int(1, 365 * DAY, 7 * DAY),
    // An SSO session that has issued no code for this long is treated as
    // expired. At most USER_SESSION_TTL; defaults to 3 days, or
    // USER_SESSION_TTL when that is shorter.
    USER_SESSION_IDLE_TTL: z.coerce
      .number()
      .int()
      .min(1)
      .max(365 * DAY)
      .optional(),
    AUTHORIZATION_CODE_TTL: int(1, 600, 120),
    // Seconds a login flow (the login, consent and org-select steps, their
    // cookies and sessions) stays usable: a person reads and types, so it
    // is longer than an authorization code, which a client redeems at once.
    LOGIN_FLOW_TTL: int(1, HOUR, 900),
    // Changing the issuer invalidates every outstanding token (`iss` claim).
    // Defaults to PUBLIC_URL; a trailing slash is dropped (checkIssuer).
    ISSUER: z.string().optional(),
    // Where the admin UI is reached: consent, login and org-select redirects,
    // the login client's redirect URI (`${UI_BASE_URL}/callback`) and the
    // share unlock page. Defaults to `PUBLIC_URL` in production, where
    // core serves it, and to the Vite dev server (http://localhost:4000)
    // otherwise. Must be https in production.
    UI_BASE_URL: z.string().url().optional(),
    // Token for first-boot setup, so it can run unattended. Unset, core
    // generates one and logs it.
    SETUP_TOKEN: z.string().min(24).optional(),
    // A JSON provisioning document, or a folder of them, declaring the
    // services, login clients and custom roles core applies at start.
    PROVISIONING_PATH: z.string().optional(),
    // The admin UI's build, served at the root when present (the Docker image has
    // it). Missing, core serves the API alone.
    UI_DIST_PATH: z.string().default(DEFAULT_UI_DIST_PATH),
    COOKIE_DOMAIN: z.string().optional(),
    // Defaults to true when NODE_ENV=production, false otherwise. Refused
    // when off in production.
    COOKIE_SECURE: z.string().optional(),
    TOTP_ENCRYPTION_KEY: z.string().length(64).optional(),
    // HMAC for the known-device login cookie (base64, 32 bytes).
    KNOWN_DEVICE_KEY: z.string().optional(),
    TOTP_ISSUER: z.string().default("Tereo"),
    TOTP_VERIFICATION_TTL: int(1, HOUR, 300),
    TOTP_SETUP_TTL: int(1, HOUR, 600),
    PROFILE_PHOTO_MAX_SIZE_MB: z.coerce.number().positive().max(100).default(5),
    // Lets an identity provider's issuer be private, loopback or plain http.
    // Tests and local development only; refused in production.
    OIDC_ALLOW_PRIVATE_ISSUERS: bool("false"),

    // -------------------------------------------------------------------------
    // services
    // -------------------------------------------------------------------------
    // How long an item may be missing from its service's declaration before it
    // is retired. Covers rolling deploys, where old and new versions alternate.
    REGISTRY_RETIREMENT_GRACE_HOURS: z.coerce
      .number()
      .min(0)
      .max(8760)
      .default(24),
    // How long a service's replaced secret keeps working after a regenerate.
    SERVICE_SECRET_OVERLAP_HOURS: z.coerce
      .number()
      .min(0)
      .max(8760)
      .default(24),

    // -------------------------------------------------------------------------
    // files
    // -------------------------------------------------------------------------
    FILE_SERVICE_STORAGE_PATH: z.string().default("./storage"),
    FILE_SERVICE_TEMP_PATH: z.string().default("./storage/temp"),
    FILE_SERVICE_MAX_UPLOAD_SIZE_MB: z.coerce
      .number()
      .positive()
      .max(10240)
      .default(100),
    // Plaintext held at once by downloads of blobs verified in memory, and
    // how long a download waits for room in it before a 503.
    FILE_SERVICE_VERIFIED_READ_BUDGET_MB: int(16, 65536, 256),
    FILE_SERVICE_VERIFIED_READ_WAIT_SECONDS: int(1, 600, 30),
    FILE_SERVICE_ACTIVE_MASTER_KEY_VERSION: z.coerce
      .number()
      .int()
      .positive()
      .default(1),
    // HMAC key(s) for presigned and share URLs (FILE_SERVICE_SIGNING_KEY_V{n}).
    ...cursorSigningEnvFields("FILE_SERVICE"),
    SIGNING_KEYS: z.record(z.string(), z.string()),
    // Base of presigned and share URLs. Defaults to `${PUBLIC_URL}/v1/files`.
    FILE_SERVICE_PUBLIC_BASE_URL: z.string().url().optional(),
    FILE_SERVICE_PRESIGN_CLOCK_SKEW_SECONDS: int(0, HOUR, 30),
    FILE_SERVICE_MULTIPART_UPLOAD_TTL_HOURS: int(1, 8760, 24),
    FILE_SERVICE_ORPHAN_BLOB_GRACE_SECONDS: int(0, 30 * DAY, 300),
    FILE_SERVICE_MIN_PART_SIZE_MB: z.coerce
      .number()
      .positive()
      .max(5120)
      .default(5),
    FILE_SERVICE_MAX_MULTIPART_PARTS: int(1, 100_000, 10_000),
    // Active (not completed, aborted or expired) uploads per user per bucket.
    FILE_SERVICE_MAX_ACTIVE_MULTIPART_UPLOADS: int(1, 100_000, 100),
    FILE_SERVICE_MAX_PRESIGN_TTL_SECONDS: int(1, 365 * DAY, 7 * 24 * 60 * 60),
    FILE_SERVICE_MAX_ARCHIVE_OBJECTS: int(1, 10_000_000, 10_000),
    FILE_SERVICE_MAX_ARCHIVE_TOTAL_BYTES: int(
      1,
      Number.MAX_SAFE_INTEGER,
      50 * 1024 * 1024 * 1024
    ),
    FILE_SERVICE_MAX_SHARE_TTL_SECONDS: int(
      1,
      10 * 365 * DAY,
      365 * 24 * 60 * 60
    ),
    FILE_SERVICE_SHARE_SIGNED_URL_TTL_SECONDS: int(1, HOUR, 60),
    FILE_SERVICE_SHARE_UNLOCK_MAX_ATTEMPTS: int(1, 1000, 5),
    FILE_SERVICE_SHARE_UNLOCK_WINDOW_SECONDS: int(1, DAY, 900),
    FILE_SERVICE_SHARE_DEFAULT_TOKEN_BYTES: z.coerce
      .number()
      .int()
      .min(12)
      .max(48)
      .default(18),
    FILE_SERVICE_EMIT_SHARE_ACCESS_EVENTS: bool("false"),
    // Where browsers opening a password-protected share are sent for the unlock
    // page. Defaults to UI_BASE_URL.
    FILE_SERVICE_SHARE_UI_BASE_URL: z.string().url().optional(),
    // Grace window between a share becoming unserveable (revoked/expired), or
    // an archive request expiring, and the sweep hard-deleting the row.
    FILE_SERVICE_SHARE_RETENTION_DAYS: int(0, 3650, 30),
    // How long a `files.access_logs` row is kept before the daily sweep
    // deletes it.
    ACCESS_LOG_RETENTION_DAYS: int(1, 3650, 90),
    FILE_SERVICE_SWEEP_TIME_BOX_SECONDS: int(1, HOUR, 60),
    FILE_SERVICE_SWEEP_HEARTBEAT_SECONDS: int(1, HOUR, 5),
    FILE_SERVICE_DISK_RECONCILIATION_MAX_FILES_PER_SHARD: int(
      1,
      10_000_000,
      10_000
    ),

    // -------------------------------------------------------------------------
    // webhooks
    // -------------------------------------------------------------------------
    // How long a rotated-out endpoint signing secret still signs deliveries.
    WEBHOOK_SECRET_OVERLAP_HOURS: z.coerce
      .number()
      .min(0)
      .max(8760)
      .default(24),
    // How long a PENDING delivery may go untouched before the sweep queues it
    // again: one written while Redis was down was never queued.
    WEBHOOK_STALE_DELIVERY_SECONDS: int(1, DAY, 300),

    // -------------------------------------------------------------------------
    // outbox
    // -------------------------------------------------------------------------
    // How long a dead-lettered outbox row is kept for replay before the
    // retention sweep deletes it.
    OUTBOX_DEAD_LETTER_RETENTION_DAYS: int(1, 3650, 30),

    // -------------------------------------------------------------------------
    // audit
    // -------------------------------------------------------------------------
    AUDIT_RETENTION_DAYS: int(1, 3650, 90),
    // How long creating or dropping a partition of the audit, webhook-delivery
    // or notification tables waits for its parent's lock before giving up.
    PARTITION_DDL_LOCK_TIMEOUT_MS: int(100, 60_000, 5_000),

    // -------------------------------------------------------------------------
    // notifications
    // -------------------------------------------------------------------------
    // Lets a connection point at a private or loopback host (a local mail
    // catcher). Development and tests only.
    NOTIFICATIONS_ALLOW_PRIVATE_HOSTS: bool("false"),
    // Lets an SMTP connection use `security: "none"`, sending mail and the
    // password in the clear (a local mail catcher).
    ALLOW_PLAINTEXT_SMTP: bool("false"),
  })
  .superRefine((val, ctx) => {
    refineRedisEnv(val, ctx);
    for (const [name, value] of Object.entries(val.SIGNING_KEYS)) {
      if (!isBase64Key(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `${name} must decode to exactly 32 bytes of base64`,
        });
      }
    }
    if (
      val.NODE_ENV === "production" &&
      val.NOTIFICATIONS_ALLOW_PRIVATE_HOSTS
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["NOTIFICATIONS_ALLOW_PRIVATE_HOSTS"],
        message: "NOTIFICATIONS_ALLOW_PRIVATE_HOSTS is refused in production",
      });
    }
    refineKeyEnv(val, ctx);
    if (
      val.USER_SESSION_IDLE_TTL !== undefined &&
      val.USER_SESSION_IDLE_TTL > val.USER_SESSION_TTL
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["USER_SESSION_IDLE_TTL"],
        message: "USER_SESSION_IDLE_TTL must not exceed USER_SESSION_TTL",
      });
    }
    if (val.NODE_ENV === "production" && !val.CORS_ALLOWED_ORIGINS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CORS_ALLOWED_ORIGINS"],
        message: "CORS_ALLOWED_ORIGINS is required in production",
      });
    }
    const corsIssue = checkCorsOrigins(val.CORS_ALLOWED_ORIGINS, val.NODE_ENV);
    if (corsIssue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CORS_ALLOWED_ORIGINS"],
        message: corsIssue,
      });
    }
    const issuerIssue = checkIssuer(val.ISSUER, val.NODE_ENV);
    if (issuerIssue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ISSUER"],
        message: issuerIssue,
      });
    }
    const trustProxyIssue = checkTrustProxy(val.TRUST_PROXY, val.NODE_ENV);
    if (trustProxyIssue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TRUST_PROXY"],
        message: trustProxyIssue,
      });
    }
    const publicUrlIssue = checkPublicUrl(val.PUBLIC_URL, val.NODE_ENV);
    if (publicUrlIssue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PUBLIC_URL"],
        message: publicUrlIssue,
      });
    }
    const uiBaseUrlIssue = checkUiBaseUrl(val.UI_BASE_URL, val.NODE_ENV);
    if (uiBaseUrlIssue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["UI_BASE_URL"],
        message: uiBaseUrlIssue,
      });
    }
    const cookieSecureIssue = checkCookieSecure(
      val.COOKIE_SECURE,
      val.NODE_ENV
    );
    if (cookieSecureIssue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["COOKIE_SECURE"],
        message: cookieSecureIssue,
      });
    }
    const oidcPrivateIssue = checkOidcAllowPrivateIssuers(
      val.OIDC_ALLOW_PRIVATE_ISSUERS,
      val.NODE_ENV
    );
    if (oidcPrivateIssue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OIDC_ALLOW_PRIVATE_ISSUERS"],
        message: oidcPrivateIssue,
      });
    }
  })
  .transform(({ SIGNING_KEYS, ...raw }) => {
    const val = { ...raw, PUBLIC_URL: raw.PUBLIC_URL ?? DEV_PUBLIC_URL };
    const publicUrl = val.PUBLIC_URL.replace(/\/+$/, "");
    const uiBaseUrl = resolveUiBaseUrl(val);
    const resolved = {
      ...val,
      ...SIGNING_KEYS,
      PUBLIC_URL: publicUrl,
      // Always set once loadKeys() has run; nothing reads them before.
      JWT_PRIVATE_KEY: val.JWT_PRIVATE_KEY as string,
      JWT_PUBLIC_KEY: val.JWT_PUBLIC_KEY as string,
      JWT_KEY_ID: val.JWT_KEY_ID as string,
      TOTP_ENCRYPTION_KEY: val.TOTP_ENCRYPTION_KEY as string,
      KNOWN_DEVICE_KEY: val.KNOWN_DEVICE_KEY as string,
      TRUST_PROXY: val.TRUST_PROXY || DEFAULT_TRUST_PROXY,
      USER_SESSION_IDLE_TTL:
        val.USER_SESSION_IDLE_TTL ?? Math.min(3 * DAY, val.USER_SESSION_TTL),
      COOKIE_SECURE: resolveCookieSecure(val.COOKIE_SECURE, val.NODE_ENV),
      UI_BASE_URL: uiBaseUrl,
      UI_DIST_PATH: path.resolve(val.UI_DIST_PATH),
      CORS_ALLOWED_ORIGINS: val.CORS_ALLOWED_ORIGINS ?? [
        new URL(uiBaseUrl).origin,
      ],
      SERVICE_NAME: "tereo" as const,
      ISSUER: val.ISSUER?.replace(/\/+$/, "") ?? publicUrl,
      FILE_SERVICE_PUBLIC_BASE_URL:
        val.FILE_SERVICE_PUBLIC_BASE_URL ?? `${publicUrl}/v1/files`,
      FILE_SERVICE_SHARE_UI_BASE_URL:
        val.FILE_SERVICE_SHARE_UI_BASE_URL ?? uiBaseUrl,
    };
    return resolved as typeof resolved & SigningKeys;
  })
  .refine(
    (val) =>
      val.NODE_ENV !== "production" ||
      !val.FILE_SERVICE_PUBLIC_BASE_URL.startsWith("http://localhost"),
    {
      message:
        "FILE_SERVICE_PUBLIC_BASE_URL (or PUBLIC_URL) must be a real public URL in production",
      path: ["FILE_SERVICE_PUBLIC_BASE_URL"],
    }
  );

export const EnvSchema = z.preprocess(prepareEnv, EnvFields);

export type Env = z.infer<typeof EnvSchema>;

const env = EnvSchema.parse({
  ...process.env,
  JWT_PRIVATE_KEY: readSecret("JWT_PRIVATE_KEY", true),
  JWT_PUBLIC_KEY: readSecret("JWT_PUBLIC_KEY", true),
});

export default env;
