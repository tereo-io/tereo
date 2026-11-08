import { Prisma, UserType } from "../../prisma/generated/client/index.js";
import { getDefaultOrganizationId } from "./defaultOrganization.js";
import { PASSWORD_LINK_PURPOSES } from "./db/userLinkTokens.js";
import { emitTx, logAuditTx, notifyTx } from "./outbox.js";
import { SYSTEM_USER_ID } from "../definitions/index.js";
import { ConflictError } from "./errors.js";
import { hashFlowToken } from "./crypto.js";
import { randomBytes } from "node:crypto";
import db from "./db/index.js";
import env from "../env.js";

/**
 * Retires the user's live setup link and pending forced-change grants, in the
 * caller's transaction. Called wherever control of the account changes hands
 * (promotion, a new password or email, deactivation): a link handed to an
 * inviter must not outlive the account it was issued for.
 */
export const retirePasswordLinks = async (
  tx: Prisma.TransactionClient,
  userId: string
): Promise<void> => {
  await db.userLinkTokens.invalidateForUser(userId, PASSWORD_LINK_PURPOSES, tx);
  await db.passwordChangeGrants.deleteForUser(userId, tx);
};

/** Retires the user's live verify link too: for a change of the address itself. */
export const retireAllLinks = async (
  tx: Prisma.TransactionClient,
  userId: string
): Promise<void> => {
  await retirePasswordLinks(tx, userId);
  await db.userLinkTokens.invalidateForUser(userId, ["verify"], tx);
};

export interface IssuedPasswordLink {
  url: string;
  expiresAt: Date;
}

const uiBase = () => env.UI_BASE_URL.replace(/\/$/, "");

export const lockUser = (tx: Prisma.TransactionClient, userId: string) =>
  // Two issues for one user serialise here: the second would otherwise hit
  // the one-live-token index.
  tx.$executeRaw`
    SELECT 1 FROM "auth"."users" WHERE "id" = ${userId}::uuid FOR UPDATE`;

// Without a connection, a send is queued and never leaves.
export const assertEmailConfigured = async (tx?: Prisma.TransactionClient) => {
  if (!(await db.notificationConnections.getDefault("email", tx))) {
    throw new ConflictError(
      "No default email connection is configured",
      "email_not_configured"
    );
  }
};

/**
 * Refuses an account that has no address of its own to confirm, or an address
 * already confirmed: the system user, service accounts and deactivated users
 * (409 `user_not_verifiable`), then a verified address (409 `already_verified`).
 */
export const assertVerifiable = (user: {
  id: string;
  userType: UserType;
  isActive: boolean;
  emailVerifiedAt: Date | null;
}) => {
  if (
    user.id === SYSTEM_USER_ID ||
    user.userType === UserType.service_account ||
    !user.isActive
  ) {
    throw new ConflictError(
      "This account has no address to verify",
      "user_not_verifiable"
    );
  }
  if (user.emailVerifiedAt) {
    throw new ConflictError(
      "The email address is already verified",
      "already_verified"
    );
  }
};

/**
 * Issues a one-time link for the user to set their password (`setup`) or
 * reset it (`reset`), in the caller's transaction, replacing any earlier
 * password link. The token is in the URL fragment, so it stays out of server
 * and proxy logs; only its hash is stored. With `notify`, the link is emailed
 * to the user's address through the default email connection (409
 * `email_not_configured` without one). Audited as `createdBy`; `requestIp`,
 * when given, goes into the audit metadata.
 */
export const issuePasswordLink = async (
  tx: Prisma.TransactionClient,
  {
    userId,
    purpose,
    createdBy,
    notify,
    clientId,
    requestIp,
  }: {
    userId: string;
    purpose: "setup" | "reset";
    createdBy: string;
    notify: boolean;
    clientId?: string;
    requestIp?: string;
  }
): Promise<IssuedPasswordLink> => {
  await lockUser(tx, userId);
  const user = await db.users.get(userId, tx);
  const creator = await db.users.get(createdBy, tx);

  if (notify) await assertEmailConfigured(tx);

  await db.userLinkTokens.invalidateForUser(userId, PASSWORD_LINK_PURPOSES, tx);
  const token = randomBytes(32).toString("base64url");
  const ttlSeconds =
    purpose === "reset"
      ? env.PASSWORD_RESET_TTL_SECONDS
      : env.PASSWORD_SETUP_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await db.userLinkTokens.create(
    {
      userId,
      purpose,
      tokenHash: hashFlowToken(token),
      createdBy,
      expiresAt,
    },
    tx
  );
  const query =
    clientId === undefined ? "" : `?client_id=${encodeURIComponent(clientId)}`;
  const url = `${uiBase()}/set-password${query}#token=${token}`;

  if (notify) {
    await notifyTx(tx, {
      channel: "email",
      sensitive: true,
      recipients: [{ address: user.email }],
      content:
        purpose === "reset"
          ? {
              subject: "Reset your password",
              text: `Use this link to reset your password:\n\n${url}\n\nThe link works once and expires on ${expiresAt.toUTCString()}.\n\nIf you didn't ask for this, you can ignore this email; your password hasn't changed.`,
            }
          : {
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
    metadata: {
      action:
        purpose === "reset"
          ? "password_reset_requested"
          : "password_setup_link_issued",
      notified: notify,
      ...(requestIp !== undefined && { ip: requestIp }),
    },
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType:
      purpose === "reset"
        ? "auth.user.password-reset-requested"
        : "auth.user.password-setup-link-issued",
    entityType: "User",
    entityId: user.id,
    data:
      purpose === "reset"
        ? {
            userId: user.id,
            email: user.email,
            expiresAt: expiresAt.toISOString(),
          }
        : {
            userId: user.id,
            email: user.email,
            expiresAt: expiresAt.toISOString(),
            notified: notify,
          },
  });

  return { url, expiresAt };
};

/**
 * Emails the user a one-time link confirming their current address, in the
 * caller's transaction, replacing any earlier verify link. The address is
 * stored with the token, so a later change of email voids it. The URL is
 * never returned: only the inbox holds it.
 */
export const issueVerifyLink = async (
  tx: Prisma.TransactionClient,
  { userId, createdBy }: { userId: string; createdBy: string }
): Promise<{ expiresAt: Date }> => {
  await lockUser(tx, userId);
  const user = await db.users.get(userId, tx);
  const creator = await db.users.get(createdBy, tx);

  await assertEmailConfigured(tx);

  await db.userLinkTokens.invalidateForUser(userId, ["verify"], tx);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    Date.now() + env.EMAIL_VERIFICATION_TTL_SECONDS * 1000
  );
  await db.userLinkTokens.create(
    {
      userId,
      purpose: "verify",
      email: user.email,
      tokenHash: hashFlowToken(token),
      createdBy,
      expiresAt,
    },
    tx
  );
  const url = `${uiBase()}/verify-email#token=${token}`;

  await notifyTx(tx, {
    channel: "email",
    sensitive: true,
    recipients: [{ address: user.email }],
    content: {
      subject: "Confirm your email address",
      text: `Use this link to confirm your email address:\n\n${url}\n\nThe link expires on ${expiresAt.toUTCString()}.`,
    },
  });

  await logAuditTx(tx, {
    auth: { userId: creator.id, email: creator.email },
    action: "UPDATE",
    entityType: "User",
    entityId: user.id,
    entityName: user.email,
    metadata: { action: "email_verification_sent" },
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: "auth.user.email-verification-sent",
    entityType: "User",
    entityId: user.id,
    data: {
      userId: user.id,
      email: user.email,
      expiresAt: expiresAt.toISOString(),
    },
  });

  return { expiresAt };
};

/**
 * Marks the user's address verified, only if it is not already: the
 * conditional update makes concurrent confirmations write one audit entry and
 * one event. Returns whether this call changed it. The user is the actor when
 * they proved it themselves (`link`, `password_link`); core otherwise.
 */
export const markEmailVerified = async (
  tx: Prisma.TransactionClient,
  {
    userId,
    via,
    email,
  }: {
    userId: string;
    via: "link" | "password_link" | "provider" | "setup";
    /** The address that was proven: nothing is marked if it has changed since. */
    email?: string;
  }
): Promise<boolean> => {
  const { count } = await tx.user.updateMany({
    where: { id: userId, emailVerifiedAt: null, ...(email && { email }) },
    data: { emailVerifiedAt: new Date() },
  });
  if (count === 0) return false;

  const user = await db.users.get(userId, tx);
  const actor =
    via === "link" || via === "password_link"
      ? user
      : await db.users.get(SYSTEM_USER_ID, tx);
  await logAuditTx(tx, {
    auth: { userId: actor.id, email: actor.email },
    action: "UPDATE",
    entityType: "User",
    entityId: user.id,
    entityName: user.email,
    metadata: { action: "email_verified", via },
  });
  await emitTx(tx, {
    organizationId: getDefaultOrganizationId(),
    eventType: "auth.user.email-verified",
    entityType: "User",
    entityId: user.id,
    data: { userId: user.id, email: user.email, via },
  });
  return true;
};
