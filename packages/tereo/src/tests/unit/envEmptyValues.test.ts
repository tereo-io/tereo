import { describe, expect, it } from "vitest";
import { EnvSchema } from "../../env.js";
import { randomBytes } from "crypto";

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://core:core@localhost:5432/core",
  REDIS_URL: "redis://localhost:6379",
};

const parse = (overrides: Record<string, string>) =>
  EnvSchema.parse({ ...base, ...overrides });

const key = () => randomBytes(32).toString("base64");

describe("env values set to an empty string", () => {
  it.each([
    "REGISTRY_RETIREMENT_GRACE_HOURS",
    "SERVICE_SECRET_OVERLAP_HOURS",
    "WEBHOOK_SECRET_OVERLAP_HOURS",
    "FILE_SERVICE_ORPHAN_BLOB_GRACE_SECONDS",
    "FILE_SERVICE_SHARE_RETENTION_DAYS",
    "WORKER_HEALTH_PORT",
    "FILE_SERVICE_ACTIVE_SIGNING_KEY_VERSION",
  ] as const)("leave %s at its default", (name) => {
    expect(parse({ [name]: "" })[name]).toBe(parse({})[name]);
  });

  it("leave ISSUER at PUBLIC_URL", () => {
    expect(
      parse({ ISSUER: "", PUBLIC_URL: "http://localhost:4001" }).ISSUER
    ).toBe("http://localhost:4001");
  });
});

describe("signing keys in env", () => {
  it("keeps every version, not only the first two", () => {
    const cursor = key();
    const files = key();
    const env = parse({
      CURSOR_SIGNING_KEY_V3: cursor,
      FILE_SERVICE_SIGNING_KEY_V12: files,
    });
    expect(env.CURSOR_SIGNING_KEY_V3).toBe(cursor);
    expect(env.FILE_SERVICE_SIGNING_KEY_V12).toBe(files);
  });

  it("refuses a key of any version that is not 32 bytes of base64", () => {
    const result = EnvSchema.safeParse({
      ...base,
      FILE_SERVICE_SIGNING_KEY_V3: "short",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual([
      "FILE_SERVICE_SIGNING_KEY_V3",
    ]);
  });

  it("treats an empty key as unset", () => {
    expect(parse({ CURSOR_SIGNING_KEY_V3: "" }).CURSOR_SIGNING_KEY_V3).toBe(
      undefined
    );
  });
});
