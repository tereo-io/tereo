import { describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { z } from "zod";
import {
  buildRedisConnection,
  parseSentinels,
  redisEnvFields,
  refineRedisEnv,
} from "../../utils/redisEnv.js";

const schema = z
  .object({ ...redisEnvFields() })
  .superRefine((val, ctx) => refineRedisEnv(val, ctx));

describe("refineRedisEnv (≥1 connection required)", () => {
  it("accepts REDIS_URL alone", () => {
    expect(
      schema.safeParse({ REDIS_URL: "redis://localhost:6379" }).success
    ).toBe(true);
  });

  it("accepts Sentinel (hosts + master name) alone", () => {
    expect(
      schema.safeParse({
        REDIS_SENTINELS: "s1:26379,s2:26379",
        REDIS_MASTER_NAME: "mymaster",
      }).success
    ).toBe(true);
  });

  it("rejects when neither is set", () => {
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("rejects Sentinel hosts without a master name", () => {
    expect(schema.safeParse({ REDIS_SENTINELS: "s1:26379" }).success).toBe(
      false
    );
  });
});

describe("parseSentinels", () => {
  it("parses host:port pairs", () => {
    expect(parseSentinels("a:26379, b:26380")).toEqual([
      { host: "a", port: 26379 },
      { host: "b", port: 26380 },
    ]);
  });

  it("defaults the port to 26379 and skips blanks", () => {
    expect(parseSentinels("a, ,b:5000")).toEqual([
      { host: "a", port: 26379 },
      { host: "b", port: 5000 },
    ]);
  });
});

describe("buildRedisConnection", () => {
  it("returns the URL for single-node", () => {
    expect(
      buildRedisConnection({ REDIS_URL: "redis://localhost:6379" })
    ).toEqual({ url: "redis://localhost:6379", options: {} });
  });

  it("returns a Sentinel config when sentinels + master are set", () => {
    expect(
      buildRedisConnection({
        REDIS_SENTINELS: "s1:26379,s2",
        REDIS_MASTER_NAME: "mymaster",
        REDIS_PASSWORD: "pw",
      })
    ).toEqual({
      options: {
        sentinels: [
          { host: "s1", port: 26379 },
          { host: "s2", port: 26379 },
        ],
        name: "mymaster",
        password: "pw",
      },
    });
  });

  it("prefers Sentinel over a stray REDIS_URL", () => {
    const conn = buildRedisConnection({
      REDIS_URL: "redis://ignored:6379",
      REDIS_SENTINELS: "s1:26379",
      REDIS_MASTER_NAME: "mymaster",
    });
    expect(conn.url).toBeUndefined();
  });

  it("applies REDIS_DB in URL mode", () => {
    expect(
      buildRedisConnection({ REDIS_URL: "redis://localhost:6379", REDIS_DB: 3 })
    ).toEqual({ url: "redis://localhost:6379/3", options: {} });
  });

  it("applies REDIS_DB in Sentinel mode", () => {
    const conn = buildRedisConnection({
      REDIS_SENTINELS: "s1",
      REDIS_MASTER_NAME: "mymaster",
      REDIS_DB: 7,
    });
    expect(conn.options.db).toBe(7);
  });

  it("lets REDIS_DB override the URL's database", () => {
    const { url, options } = buildRedisConnection({
      REDIS_URL: "redis://localhost:6379/2",
      REDIS_DB: 5,
    });
    const client = new Redis(url as string, { ...options, lazyConnect: true });
    expect(client.options.db).toBe(5);
    client.disconnect();
  });

  it("keeps the URL's database when REDIS_DB is unset", () => {
    const { url, options } = buildRedisConnection({
      REDIS_URL: "redis://localhost:6379/2",
    });
    const client = new Redis(url as string, { ...options, lazyConnect: true });
    expect(client.options.db).toBe(2);
    client.disconnect();
  });
});

describe("REDIS_DB and REDIS_KEY_PREFIX", () => {
  const base = { REDIS_URL: "redis://localhost:6379" };

  it("coerces REDIS_DB and bounds it to 0-15", () => {
    expect(schema.parse({ ...base, REDIS_DB: "4" }).REDIS_DB).toBe(4);
    expect(schema.safeParse({ ...base, REDIS_DB: "16" }).success).toBe(false);
    expect(schema.safeParse({ ...base, REDIS_DB: "-1" }).success).toBe(false);
    expect(schema.safeParse({ ...base, REDIS_DB: "1.5" }).success).toBe(false);
  });

  it("defaults REDIS_KEY_PREFIX to empty", () => {
    expect(schema.parse(base).REDIS_KEY_PREFIX).toBe("");
  });

  it.each(["app1:", "tereo-prod.", "a_b:c-1."])("accepts prefix %s", (p) => {
    expect(
      schema.parse({ ...base, REDIS_KEY_PREFIX: p }).REDIS_KEY_PREFIX
    ).toBe(p);
  });

  it.each(["has space", "a{b}", "a*", "x".repeat(65)])(
    "rejects prefix %s",
    (p) => {
      expect(schema.safeParse({ ...base, REDIS_KEY_PREFIX: p }).success).toBe(
        false
      );
    }
  );
});
