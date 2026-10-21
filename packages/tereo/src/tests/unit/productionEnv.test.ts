import { describe, expect, it } from "vitest";
import { EnvSchema } from "../../env.js";

const production = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://core:core@db:5432/core",
  REDIS_URL: "redis://redis:6379",
  PUBLIC_URL: "https://core.example.com",
  CORS_ALLOWED_ORIGINS: "https://core.example.com",
  TRUST_PROXY: "1",
  CORE_KEK: Buffer.alloc(32, 1).toString("base64"),
};

const issuesFor = (overrides: Record<string, string>) => {
  const result = EnvSchema.safeParse({ ...production, ...overrides });
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join("."));
};

describe("production env", () => {
  it("accepts a safe production configuration", () => {
    expect(issuesFor({})).toEqual([]);
    expect(
      issuesFor({
        COOKIE_SECURE: "true",
        UI_BASE_URL: "https://admin.example.com",
        TRUST_PROXY: "10.0.0.0/8,192.168.0.0/16",
      })
    ).toEqual([]);
  });

  it.each(["true", "TRUE"])("refuses TRUST_PROXY=%s", (value) => {
    expect(issuesFor({ TRUST_PROXY: value })).toContain("TRUST_PROXY");
  });

  it.each(["1", "loopback", "false", "10.0.0.0/8"])(
    "accepts TRUST_PROXY=%s",
    (value) => {
      expect(issuesFor({ TRUST_PROXY: value })).toEqual([]);
    }
  );

  it.each(["false", "0"])("refuses COOKIE_SECURE=%s", (value) => {
    expect(issuesFor({ COOKIE_SECURE: value })).toContain("COOKIE_SECURE");
  });

  it("refuses an http PUBLIC_URL", () => {
    expect(
      issuesFor({
        PUBLIC_URL: "http://core.example.com",
        CORS_ALLOWED_ORIGINS: "http://core.example.com",
      })
    ).toContain("PUBLIC_URL");
  });

  it("refuses an http UI_BASE_URL", () => {
    expect(issuesFor({ UI_BASE_URL: "http://admin.example.com" })).toContain(
      "UI_BASE_URL"
    );
  });

  it.each([
    ["not a url", "ISSUER must be a URL"],
    ["http://core.example.com", "https:// URL in production"],
    ["https://core.example.com?x=1", "query or fragment"],
    ["https://core.example.com#x", "query or fragment"],
  ])("refuses ISSUER=%s", (value, message) => {
    const result = EnvSchema.safeParse({ ...production, ISSUER: value });
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.find((i) => i.path.join(".") === "ISSUER")?.message
    ).toContain(message);
  });

  it("drops a trailing slash from ISSUER", () => {
    const parsed = EnvSchema.parse({
      ...production,
      ISSUER: "https://id.example.com/",
    });
    expect(parsed.ISSUER).toBe("https://id.example.com");
    expect(
      EnvSchema.parse({
        ...production,
        PUBLIC_URL: "https://core.example.com/",
      }).ISSUER
    ).toBe("https://core.example.com");
  });

  it.each([
    ["*", "CORS_ALLOWED_ORIGINS"],
    [
      "https://app.example.com,http://admin.example.com",
      "CORS_ALLOWED_ORIGINS",
    ],
  ])("refuses CORS_ALLOWED_ORIGINS=%s", (value, path) => {
    expect(issuesFor({ CORS_ALLOWED_ORIGINS: value })).toContain(path);
  });

  it("requires CORS_ALLOWED_ORIGINS", () => {
    const { CORS_ALLOWED_ORIGINS: _unset, ...rest } = production;
    const result = EnvSchema.safeParse(rest);
    expect(result.error?.issues.map((i) => i.path.join("."))).toContain(
      "CORS_ALLOWED_ORIGINS"
    );
  });

  it("accepts https and loopback CORS origins", () => {
    expect(
      issuesFor({
        CORS_ALLOWED_ORIGINS:
          "https://app.example.com, http://localhost:3000,http://127.0.0.1:5173",
      })
    ).toEqual([]);
  });

  it.each(["development", "test"])(
    "leaves all three alone in %s",
    (nodeEnv) => {
      expect(
        issuesFor({
          NODE_ENV: nodeEnv,
          TRUST_PROXY: "true",
          COOKIE_SECURE: "false",
          PUBLIC_URL: "http://localhost:4001",
          UI_BASE_URL: "http://localhost:4000",
          ISSUER: "http://localhost:4001",
          CORS_ALLOWED_ORIGINS: "*",
        })
      ).toEqual([]);
    }
  );
});
