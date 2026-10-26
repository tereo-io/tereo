// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import { EnvSchema } from "../env.js";

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://core:core@localhost:5432/core",
  REDIS_URL: "redis://localhost:6379",
};

const parse = (overrides: Record<string, string>) =>
  EnvSchema.safeParse({ ...base, ...overrides });

describe("EnvSchema", () => {
  it("accepts the defaults", () => {
    expect(parse({}).success).toBe(true);
  });

  it.each([
    ["PORT", "65536"],
    ["JWT_ACCESS_TOKEN_TTL", String(24 * 3600 + 1)],
    ["JWT_REFRESH_TOKEN_TTL", String(366 * 86400)],
    ["USER_SESSION_TTL", String(366 * 86400)],
    ["AUTHORIZATION_CODE_TTL", "601"],
    ["LOGIN_FLOW_TTL", "3601"],
    ["TOTP_VERIFICATION_TTL", "3601"],
    ["TOTP_SETUP_TTL", "3601"],
    ["AUDIT_RETENTION_DAYS", "3651"],
    ["OUTBOX_DEAD_LETTER_RETENTION_DAYS", "3651"],
    ["WEBHOOK_STALE_DELIVERY_SECONDS", "86401"],
    ["DB_POOL_MAX", "1001"],
    ["DB_POOL_CONNECTION_TIMEOUT_MS", "600001"],
  ])("rejects %s above its maximum (%s)", (name, value) => {
    expect(parse({ [name]: value }).success).toBe(false);
  });

  it.each([
    "PORT",
    "JWT_ACCESS_TOKEN_TTL",
    "JWT_REFRESH_TOKEN_TTL",
    "USER_SESSION_TTL",
    "AUTHORIZATION_CODE_TTL",
    "LOGIN_FLOW_TTL",
    "TOTP_VERIFICATION_TTL",
    "TOTP_SETUP_TTL",
    "PROFILE_PHOTO_MAX_SIZE_MB",
    "FILE_SERVICE_MAX_UPLOAD_SIZE_MB",
    "OUTBOX_DEAD_LETTER_RETENTION_DAYS",
    "DB_POOL_MAX",
  ])("rejects %s of 0, negative or fractional", (name) => {
    for (const value of ["0", "-1"]) {
      expect(parse({ [name]: value }).success).toBe(false);
    }
    if (name.endsWith("_MB")) return;
    expect(parse({ [name]: "1.5" }).success).toBe(false);
  });

  it("rejects a SETUP_TOKEN shorter than 24 characters", () => {
    expect(parse({ SETUP_TOKEN: "x".repeat(23) }).success).toBe(false);
    expect(parse({ SETUP_TOKEN: "x".repeat(24) }).success).toBe(true);
  });

  it("rejects a DB_POOL_MIN above DB_POOL_MAX", () => {
    expect(parse({ DB_POOL_MAX: "10", DB_POOL_MIN: "11" }).success).toBe(false);
  });

  it("accepts values at the limits", () => {
    expect(
      parse({
        PORT: "65535",
        JWT_ACCESS_TOKEN_TTL: "86400",
        JWT_REFRESH_TOKEN_TTL: String(365 * 86400),
        USER_SESSION_TTL: String(365 * 86400),
        AUTHORIZATION_CODE_TTL: "600",
        LOGIN_FLOW_TTL: "3600",
        DB_POOL_MAX: "1000",
        DB_POOL_MIN: "1000",
      }).success
    ).toBe(true);
  });
});
