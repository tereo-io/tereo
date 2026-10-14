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
  max: 20,
  min: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
};

// One pool and one client for every module. Each module's
// `utils/db/prisma.ts` re-exports these.
const pool = new Pool(poolConfig);

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

export const disconnectDatabase = async (): Promise<void> => {
  await prisma.$disconnect();
  await pool.end();
};

/**
 * Liveness probe against the database. Issues a trivial query so a caller can
 * distinguish "Prisma client exists" from "the pool can actually reach
 * Postgres". Throws on any connectivity failure.
 */
export const healthCheck = async (): Promise<void> => {
  await prisma.$queryRaw`SELECT 1`;
};

export type { Prisma } from "../../../prisma/generated/client/index.js";
export { prisma };
