import { getDefaultOrganizationId } from "./defaultOrganization.js";
import { Prisma } from "../../prisma/generated/client/index.js";
import { emitTx, logAuditTx, notifyTx } from "./outbox.js";
import { ConflictError } from "./errors.js";
import { hashFlowToken } from "./crypto.js";
import { randomBytes } from "node:crypto";
import db from "./db/index.js";
import env from "../env.js";

export interface IssuedPasswordSetupLink {
  url: string;
  expiresAt: Date;
}

/**
 * Whether an account may still be used: active and not past its expiry. The
 * link of one that is not is as good as unknown.
 */
export const isAccountUsable = (
  user: { isActive: boolean; expiresAt: Date | null },
  now = new Date()
): boolean =>
  user.isActive && (user.expiresAt === null || user.expiresAt > now);

/**
 * Issues a one-time link for the user to set their password, in the caller's
 * transaction, replacing any earlier link. The token is in the URL fragment,
 * so it stays out of server and proxy logs; only its hash is stored. With
 * `notify`, the link is emailed to the user's address through the default
 * email connection (409 `email_not_configured` without one). Audited as
 * `createdBy`.
 */
export const issuePasswordSetupLink = async (
  tx: Prisma.TransactionClient,
  {
    userId,
    createdBy,
    notify,
  }: { userId: string; createdBy: string; notify: boolean }
): Promise<IssuedPasswordSetupLink> => {
  // Two issues for one user serialise here: the second would otherwise hit
  // the one-live-token index.
  await tx.$executeRaw`
    SELECT 1 FROM "auth"."users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
  const user = await db.users.get(userId, tx);
  const creator = await db.users.get(createdBy, tx);

  // Without a connection, a send is queued and never leaves.
  if (notify && !(await db.notificationConnections.getDefault("email", tx))) {
    throw new ConflictError(
      "No default email connection is configured",
      "email_not_configured"
    );
  }

  await db.passwordSetupTokens.invalidateForUser(userId, tx);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    Date.now() + env.PASSWORD_SETUP_TTL_SECONDS * 1000
  );
  await db.passwordSetupTokens.create(
    { userId, tokenHash: hashFlowToken(token), createdBy, expiresAt },
    tx
  );
  const url = `${env.UI_BASE_URL.replace(/\/$/, "")}/set-password#token=${token}`;

  if (notify) {
    await notifyTx(tx, {
      channel: "email",
      sensitive: true,
      recipients: [{ address: user.email }],
      content: {
        subject: "Set your password",
        text: `Use this link to set your password:\n\n${url}\n\nThe link works once and expires on ${expiresAt.toUTCString()}.`,
      },
    });
  }

  await logAuditTx(tx, {
    auth: { userId: creator.id, email: creator.email },
    action: "UPDATE",
    entityType: "User",
    entityId: user.id,
    entityName: user.email,
    metadata: { action: "password_setup_link_issued", notified: notify },
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: "auth.user.password-setup-link-issued",
    entityType: "User",
    entityId: user.id,
    data: {
      userId: user.id,
      email: user.email,
      expiresAt: expiresAt.toISOString(),
      notified: notify,
    },
  });

  return { url, expiresAt };
};
