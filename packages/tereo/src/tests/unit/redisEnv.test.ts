import { describe, expect, it } from "vitest";
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
  it("returns the URL string for single-node", () => {
    expect(buildRedisConnection({ REDIS_URL: "redis://localhost:6379" })).toBe(
      "redis://localhost:6379"
    );
  });

  it("returns a Sentinel config when sentinels + master are set", () => {
    expect(
      buildRedisConnection({
        REDIS_SENTINELS: "s1:26379,s2",
        REDIS_MASTER_NAME: "mymaster",
        REDIS_PASSWORD: "pw",
      })
    ).toEqual({
      sentinels: [
        { host: "s1", port: 26379 },
        { host: "s2", port: 26379 },
      ],
      name: "mymaster",
      password: "pw",
    });
  });

  it("prefers Sentinel over a stray REDIS_URL", () => {
    const conn = buildRedisConnection({
      REDIS_URL: "redis://ignored:6379",
      REDIS_SENTINELS: "s1:26379",
      REDIS_MASTER_NAME: "mymaster",
    });
    expect(typeof conn).toBe("object");
  });
});
