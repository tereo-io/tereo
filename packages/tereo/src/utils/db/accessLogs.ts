import { prisma } from "./prisma.js";

export interface CreateAccessLogInput {
  bucketId?: number;
  objectId?: string;
  userId?: string;
  operation: string;
  statusCode: number;
  ipAddress: string;
  userAgent?: string;
  requestId?: string;
  errorMessage?: string;
}

/** The `user_agent` column's VarChar(500). */
const MAX_USER_AGENT = 500;

export const create = async (data: CreateAccessLogInput) => {
  return await prisma.accessLog.create({
    data: { ...data, userAgent: data.userAgent?.slice(0, MAX_USER_AGENT) },
  });
};

/** Deletes up to `limit` rows written before `cutoff`. Returns how many. */
export const deleteBefore = async (
  cutoff: Date,
  limit: number
): Promise<number> =>
  prisma.$executeRaw`
    DELETE FROM "files"."access_logs"
    WHERE "id" IN (
      SELECT "id" FROM "files"."access_logs"
      WHERE "timestamp" < ${cutoff}
      LIMIT ${limit}
    )
  `;
