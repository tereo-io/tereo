import { PrismaClient } from "../../../prisma/generated/client/index.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool, type PoolConfig } from "pg";
import env from "../../env.js";

// Columns are `timestamp without time zone` holding UTC, and raw SQL compares
// them with NOW(), which converts in the session's time zone: pinned to UTC
// here, whatever the server's default.
export const poolConfig: PoolConfig = {
  connectionString: env.DATABASE_URL,
  options: "-c timezone=UTC",
  max: env.DB_POOL_MAX,
  min: env.DB_POOL_MIN,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: env.DB_POOL_CONNECTION_TIMEOUT_MS,
};

// One pool and one client for every module. Each module's
// `utils/db/prisma.ts` re-exports these.
const pool = new Pool(poolConfig);

// /health's own connection: with every pool slot busy, a probe queued behind
// the requests would report Postgres down while it answers them.
const probePool = new Pool({
  ...poolConfig,
  max: 1,
  min: 0,
  connectionTimeoutMillis: 2000,
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

export const disconnectDatabase = async (): Promise<void> => {
  await prisma.$disconnect();
  await pool.end();
  await probePool.end();
};

/** Throws unless Postgres answers a query on the probe's own connection. */
export const healthCheck = async (): Promise<void> => {
  await probePool.query("SELECT 1");
};

export type { Prisma } from "../../../prisma/generated/client/index.js";
export { prisma };
