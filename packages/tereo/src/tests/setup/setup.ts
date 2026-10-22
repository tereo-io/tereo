import { prisma } from "../../utils/db/prisma.js";
import { beforeAll, beforeEach } from "vitest";
import { loadKeys } from "../../utils/keys.js";
import env from "../../env.js";
import {
  getRedisClient,
  initializeRedis,
  redisKey,
} from "../../utils/redis.js";

beforeAll(async () => {
  await initializeRedis(env);
  await prisma.$connect();
  // Tests sign tokens in this process; use the keys the server uses.
  await loadKeys();

  // Auth tests assume TOTP is optional.
  await prisma.systemSetting.upsert({
    where: { key: "totpPolicy" },
    update: { value: "optional" },
    create: { key: "totpPolicy", value: "optional" },
  });
});

// Earlier tests would otherwise exhaust rate limits or leave idempotency
// claims behind for later ones.
beforeEach(async () => {
  const redis = getRedisClient();
  for (const pattern of [
    "rl:*",
    "tereo:ratelimit*",
    "webhook-service:idempotency:*",
    "audit-log-service:idempotency:*",
  ]) {
    const keys = await redis.keys(redisKey(pattern));
    if (keys.length > 0) await redis.del(keys);
  }
});
