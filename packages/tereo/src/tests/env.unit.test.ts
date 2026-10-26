// @module-tag unit
// @module-tag platform
// @module-tag notifications
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import {
  resolveCookieSecure,
  checkOidcAllowPrivateIssuers,
  EnvSchema,
  checkPublicUrl,
  stalePathWarnings,
  checkTrustProxy,
} from "../env.js";

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

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://core:core@localhost:5432/core",
  REDIS_URL: "redis://localhost:6379",
};

const parse = (overrides: Record<string, string>) =>
  EnvSchema.parse({ ...base, ...overrides });

const key = () => randomBytes(32).toString("base64");

describe("resolveCookieSecure", () => {
  it("defaults to true in production", () => {
    expect(resolveCookieSecure(undefined, "production")).toBe(true);
    expect(resolveCookieSecure("", "production")).toBe(true);
  });

  it("defaults to false outside production", () => {
    expect(resolveCookieSecure(undefined, "development")).toBe(false);
    expect(resolveCookieSecure(undefined, "test")).toBe(false);
    expect(resolveCookieSecure(undefined, undefined)).toBe(false);
  });

  it("lets an explicit value win", () => {
    expect(resolveCookieSecure("false", "production")).toBe(false);
    expect(resolveCookieSecure("0", "production")).toBe(false);
    expect(resolveCookieSecure("true", "development")).toBe(true);
    expect(resolveCookieSecure("1", "test")).toBe(true);
  });
});

describe("checkOidcAllowPrivateIssuers", () => {
  it("refuses it in production", () => {
    expect(checkOidcAllowPrivateIssuers(true, "production")).toBe(
      "OIDC_ALLOW_PRIVATE_ISSUERS cannot be set in production"
    );
  });

  it("allows it outside production", () => {
    expect(checkOidcAllowPrivateIssuers(true, "development")).toBeUndefined();
    expect(checkOidcAllowPrivateIssuers(true, "test")).toBeUndefined();
  });

  it("allows it off in production", () => {
    expect(checkOidcAllowPrivateIssuers(false, "production")).toBeUndefined();
  });
});

describe("EnvSchema", () => {
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
});

describe("checkPublicUrl", () => {
  it("requires PUBLIC_URL in production", () => {
    expect(checkPublicUrl(undefined, "production")).toMatch(/required/);
  });

  it.each([
    "http://localhost:4001",
    "http://127.0.0.1:4001",
    "http://[::1]:4001",
  ])("refuses %s in production", (url) => {
    expect(checkPublicUrl(url, "production")).toMatch(/not localhost/);
  });

  it("refuses plain http in production", () => {
    expect(checkPublicUrl("http://core.example.com", "production")).toMatch(
      /https/
    );
  });

  it("accepts a public URL in production", () => {
    expect(
      checkPublicUrl("https://core.example.com", "production")
    ).toBeUndefined();
  });

  it("allows it unset or local outside production", () => {
    expect(checkPublicUrl(undefined, "development")).toBeUndefined();
    expect(checkPublicUrl("http://localhost:4001", "test")).toBeUndefined();
  });
});

describe("stalePathWarnings", () => {
  it.each([
    "https://core.example.com/files",
    "https://core.example.com/files/",
  ])("warns about FILE_SERVICE_PUBLIC_BASE_URL=%s", (url) => {
    expect(stalePathWarnings({ FILE_SERVICE_PUBLIC_BASE_URL: url })).toEqual([
      expect.stringMatching(/^FILE_SERVICE_PUBLIC_BASE_URL.*\/v1\/files/),
    ]);
  });

  it("warns about a UI_BASE_URL ending in /ui", () => {
    expect(
      stalePathWarnings({ UI_BASE_URL: "https://core.example.com/ui/" })
    ).toEqual([expect.stringMatching(/^UI_BASE_URL/)]);
  });

  it("warns about PROVISIONING_FILE without PROVISIONING_PATH", () => {
    expect(
      stalePathWarnings({ PROVISIONING_FILE: "/etc/tereo/provisioning.yaml" })
    ).toEqual([expect.stringMatching(/^PROVISIONING_FILE.*PROVISIONING_PATH/)]);
    expect(
      stalePathWarnings({
        PROVISIONING_FILE: "/etc/tereo/provisioning.yaml",
        PROVISIONING_PATH: "/etc/tereo/provisioning",
      })
    ).toEqual([]);
  });

  it("accepts the current paths and the defaults", () => {
    expect(
      stalePathWarnings({
        FILE_SERVICE_PUBLIC_BASE_URL: "https://core.example.com/v1/files",
        UI_BASE_URL: "https://core.example.com",
      })
    ).toEqual([]);
    expect(stalePathWarnings({})).toEqual([]);
  });

  it("leaves a /ui-named host or deeper path alone", () => {
    expect(
      stalePathWarnings({
        UI_BASE_URL: "https://ui.example.com/admin",
        FILE_SERVICE_PUBLIC_BASE_URL: "https://cdn.example.com/files/v2",
      })
    ).toEqual([]);
  });
});

describe("checkTrustProxy", () => {
  it.each([undefined, ""])("refuses %j in production", (value) => {
    expect(checkTrustProxy(value, "production")).toMatch(/must be set/);
  });

  it.each(["1", "10.0.0.0/8", "loopback", "false"])(
    "accepts an explicit %s in production",
    (value) => {
      expect(checkTrustProxy(value, "production")).toBeUndefined();
    }
  );

  it("refuses true in production", () => {
    expect(checkTrustProxy("true", "production")).toMatch(/cannot be 'true'/);
  });

  it("allows it unset or true outside production", () => {
    expect(checkTrustProxy("true", "development")).toBeUndefined();
    expect(checkTrustProxy(undefined, "development")).toBeUndefined();
    expect(checkTrustProxy(undefined, "test")).toBeUndefined();
  });
});

describe("env", () => {
  describe("NOTIFICATIONS_ALLOW_PRIVATE_HOSTS", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    const load = async () => {
      vi.resetModules();
      return (await import("../env.js")).default;
    };

    it("defaults to false and parses true outside production", async () => {
      expect((await load()).NOTIFICATIONS_ALLOW_PRIVATE_HOSTS).toBe(false);
      vi.stubEnv("NOTIFICATIONS_ALLOW_PRIVATE_HOSTS", "true");
      expect((await load()).NOTIFICATIONS_ALLOW_PRIVATE_HOSTS).toBe(true);
    });

    it("is refused in production", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("NOTIFICATIONS_ALLOW_PRIVATE_HOSTS", "true");
      await expect(load()).rejects.toThrow(/NOTIFICATIONS_ALLOW_PRIVATE_HOSTS/);
    });
  });

  describe("ALLOW_PLAINTEXT_SMTP", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    const load = async () => {
      vi.resetModules();
      return (await import("../env.js")).default;
    };

    it("defaults to false and parses true", async () => {
      vi.stubEnv("ALLOW_PLAINTEXT_SMTP", undefined);
      expect((await load()).ALLOW_PLAINTEXT_SMTP).toBe(false);
      vi.stubEnv("ALLOW_PLAINTEXT_SMTP", "true");
      expect((await load()).ALLOW_PLAINTEXT_SMTP).toBe(true);
    });
  });
});
