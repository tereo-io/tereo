import { getDefaultOrganizationId } from "./defaultOrganization.js";
import { emitTx, logAuditTx } from "./outbox.js";
import type { Prisma } from "./db/prisma.js";

/**
 * Stores a user's rate limit override (null clears it) and, only when the
 * value changes, audits it and emits `auth.user.rate-limit-changed` in `tx`.
 * Returns whether it changed.
 */
export const setRateLimitTx = async (
  tx: Prisma.TransactionClient,
  auth: { userId: string; email: string | null },
  userId: string,
  value: number | null
): Promise<boolean> => {
  // Locked, so two concurrent changes each audit the value they replaced.
  const [row] = await tx.$queryRaw<
    { email: string; rate_limit_per_second: number | null }[]
  >`SELECT "email", "rate_limit_per_second" FROM "auth"."users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
  if (row === undefined || row.rate_limit_per_second === value) return false;

  await tx.user.update({
    where: { id: userId },
    data: { rateLimitPerSecond: value },
  });
  await logAuditTx(tx, {
    auth,
    action: "UPDATE",
    entityType: "User",
    entityId: userId,
    entityName: row.email,
    metadata: {
      rateLimitPerSecond: { from: row.rate_limit_per_second, to: value },
    },
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: "auth.user.rate-limit-changed",
    entityType: "User",
    entityId: userId,
    data: { userId, rateLimitPerSecond: value },
  });
  return true;
};
