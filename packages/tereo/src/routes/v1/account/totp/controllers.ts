import { getDefaultOrganizationId } from "../../../../utils/defaultOrganization.js";
import { recordSessionsRevoked } from "../../../../utils/sessionEvents.js";
import { accountTotpFailure } from "../../../../middleware/rateLimit.js";
import { emitTx, logAuditTx } from "../../../../utils/outbox.js";
import { validateBody } from "../../../../utils/validateReq.js";
import { endUserSessions } from "../../../../utils/sessions.js";
import { validateUser } from "../../../../utils/auth.js";
import { logger } from "../../../../utils/logger.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";
import env from "../../../../env.js";
import {
  AppError,
  BadRequestError,
  ForbiddenError,
} from "../../../../utils/errors.js";
import {
  generateTotpSecret,
  generateTotpUri,
  generateTotpSetupToken,
  encryptTotpSecret,
  decryptTotpSecret,
  verifyTotpCode,
  generateRecoveryCodes,
  assertTotpSetupAllowed,
} from "../../../../utils/totp.js";
import {
  VerifySetupSchema,
  DisableTotpSchema,
  RegenerateRecoveryCodesSchema,
} from "./schemas.js";

export const getTotpStatus = async (req: Request, res: Response) => {
  const { userId } = validateUser(req);

  const status = await db.totp.getUserTotpStatus(userId);

  res.json({
    totpEnabled: status.totpEnabled,
    totpEnabledAt: status.totpEnabledAt?.toISOString() ?? null,
    totpRequired: status.totpRequired,
    recoveryCodesRemaining: status.recoveryCodesRemaining,
  });
};

export const initiateSetup = async (req: Request, res: Response) => {
  const { userId } = validateUser(req);
  await assertTotpSetupAllowed();

  const user = await db.users.get(userId);

  if (user.totpEnabled) {
    throw new BadRequestError(
      "totp_already_enabled",
      "TOTP is already enabled for your account."
    );
  }

  const secret = generateTotpSecret();
  const setupToken = generateTotpSetupToken();
  const expiresAt = new Date(Date.now() + env.TOTP_SETUP_TTL * 1000);

  const encryptedSecret = encryptTotpSecret(secret);
  await db.$transaction(async (tx) => {
    await db.totp.createSetupSession(
      { userId, setupToken, totpSecret: encryptedSecret, expiresAt },
      tx
    );
    await logAuditTx(tx, {
      auth: { userId: user.id, email: user.email },
      action: "UPDATE",
      entityType: "User",
      entityId: user.id,
      entityName: user.email,
      metadata: { action: "totp_setup_started" },
    });
  });

  const qrCodeUri = generateTotpUri({
    issuer: env.TOTP_ISSUER,
    accountName: user.email,
    secret,
  });

  res.json({
    secret,
    qrCodeUri,
    setupToken,
    expiresAt: expiresAt.toISOString(),
  });
};

export const verifySetup = async (req: Request, res: Response) => {
  const caller = validateUser(req);
  const { userId } = caller;
  await accountTotpFailure.check(req);
  const body = validateBody(VerifySetupSchema, req);
  await assertTotpSetupAllowed();

  const setupSession = await db.totp.getSetupSession(body.setupToken);
  // One begun at login is bound to that login's OAuth request instead.
  if (!setupSession || setupSession.clientId !== null) {
    throw new BadRequestError(
      "invalid_setup_token",
      "Invalid or expired setup token. Please start again."
    );
  }

  if (setupSession.userId !== userId) {
    throw new ForbiddenError("This setup token does not belong to you.");
  }

  if (setupSession.expiresAt < new Date()) {
    await db.totp.deleteSetupSession(setupSession.id);
    throw new BadRequestError(
      "setup_expired",
      "Setup session expired. Please start again."
    );
  }

  const secret = decryptTotpSecret(setupSession.totpSecret);
  const step = verifyTotpCode(secret, body.totpCode);

  if (step === null) {
    throw new BadRequestError(
      "invalid_code",
      "Invalid verification code. Please try again."
    );
  }
  await accountTotpFailure.reset(req);

  const encryptedSecret = encryptTotpSecret(secret);

  const settings = await db.settings.getTotpSettings();
  const { plainCodes, hashedCodes } = await generateRecoveryCodes(
    settings.totpRecoveryCodeCount
  );

  // Sessions opened with the password alone, possibly an attacker's, must
  // not outlive the switch to 2FA: they end in the transaction that enables
  // it. This browser stays signed in.
  const user = await db.users.get(userId);
  const actor = { userId: user.id, email: user.email };
  const recordRevoked = recordSessionsRevoked(actor, user, { self: true });
  await endUserSessions(
    userId,
    caller,
    async (tx, sessionIds, ssoSessionIds) => {
      if (!(await db.totp.enableTotp(userId, encryptedSecret, step, tx))) {
        throw new BadRequestError(
          "invalid_code",
          "Invalid verification code. Please try again."
        );
      }
      await db.totp.storeRecoveryCodes(userId, hashedCodes, tx);
      await db.totp.deleteSetupSession(setupSession.id, tx);
      await logAuditTx(tx, {
        auth: actor,
        action: "UPDATE",
        entityType: "User",
        entityId: user.id,
        entityName: user.email,
        metadata: {
          action: "totp_enabled",
          recoveryCodeCount: plainCodes.length,
        },
      });
      await emitTx(tx, {
        organizationId: getDefaultOrganizationId(),
        eventType: "auth.user.totp-enabled",
        entityType: "User",
        entityId: user.id,
        data: { userId: user.id, email: user.email },
      });
      await recordRevoked(tx, sessionIds, ssoSessionIds);
    }
  );

  logger.debug({ userId }, "User enabled TOTP");

  res.json({
    success: true,
    recoveryCodes: plainCodes,
    message:
      "TOTP enabled successfully. Save your recovery codes in a safe place.",
  });
};

export const disableTotp = async (req: Request, res: Response) => {
  const caller = validateUser(req);
  const { userId } = caller;
  await accountTotpFailure.check(req);
  const body = validateBody(DisableTotpSchema, req);

  const user = await db.users.get(userId);
  if (!user.totpEnabled) {
    throw new BadRequestError(
      "totp_not_enabled",
      "TOTP is not enabled for your account."
    );
  }

  const encryptedSecret = await db.totp.getUserTotpSecret(userId);
  if (!encryptedSecret) {
    throw new AppError(500, "server_error", "Unable to verify TOTP code.");
  }

  const secret = decryptTotpSecret(encryptedSecret);
  const step = verifyTotpCode(secret, body.totpCode);
  if (step === null || !(await db.totp.claimTotpWindow(userId, step))) {
    throw new BadRequestError("invalid_code", "Invalid verification code.");
  }
  await accountTotpFailure.reset(req);

  const status = await db.totp.getUserTotpStatus(userId);
  if (status.totpRequired) {
    throw new AppError(
      403,
      "totp_required",
      "Two-factor authentication is required for your account and cannot be disabled."
    );
  }

  // A security-settings change ends the other sessions, as a password
  // change does, in the transaction that makes it.
  const actor = { userId: user.id, email: user.email };
  const recordRevoked = recordSessionsRevoked(actor, user, { self: true });
  await endUserSessions(
    userId,
    caller,
    async (tx, sessionIds, ssoSessionIds) => {
      await db.totp.disableTotp(userId, tx);
      await logAuditTx(tx, {
        auth: actor,
        action: "UPDATE",
        entityType: "User",
        entityId: user.id,
        entityName: user.email,
        metadata: { action: "totp_disabled" },
      });
      await emitTx(tx, {
        organizationId: getDefaultOrganizationId(),
        eventType: "auth.user.totp-disabled",
        entityType: "User",
        entityId: user.id,
        data: { userId: user.id, email: user.email },
      });
      await recordRevoked(tx, sessionIds, ssoSessionIds);
    }
  );

  logger.debug({ userId }, "User disabled TOTP");

  res.json({ success: true, message: "TOTP has been disabled." });
};

export const regenerateRecoveryCodes = async (req: Request, res: Response) => {
  const { userId } = validateUser(req);
  await accountTotpFailure.check(req);
  const body = validateBody(RegenerateRecoveryCodesSchema, req);

  const user = await db.users.get(userId);
  if (!user.totpEnabled) {
    throw new BadRequestError(
      "totp_not_enabled",
      "TOTP is not enabled for your account."
    );
  }

  const encryptedSecret = await db.totp.getUserTotpSecret(userId);
  if (!encryptedSecret) {
    throw new AppError(500, "server_error", "Unable to verify TOTP code.");
  }

  const secret = decryptTotpSecret(encryptedSecret);
  const step = verifyTotpCode(secret, body.totpCode);
  if (step === null || !(await db.totp.claimTotpWindow(userId, step))) {
    throw new BadRequestError("invalid_code", "Invalid verification code.");
  }
  await accountTotpFailure.reset(req);

  const settings = await db.settings.getTotpSettings();
  const { plainCodes, hashedCodes } = await generateRecoveryCodes(
    settings.totpRecoveryCodeCount
  );
  await db.$transaction(async (tx) => {
    await db.totp.storeRecoveryCodes(userId, hashedCodes, tx);
    await logAuditTx(tx, {
      auth: { userId: user.id, email: user.email },
      action: "UPDATE",
      entityType: "User",
      entityId: user.id,
      entityName: user.email,
      metadata: {
        action: "totp_recovery_codes_regenerated",
        recoveryCodeCount: plainCodes.length,
      },
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.user.recovery-codes-regenerated",
      entityType: "User",
      entityId: user.id,
      data: { userId: user.id, email: user.email },
    });
  });

  logger.debug({ userId }, "User regenerated recovery codes");

  res.json({
    recoveryCodes: plainCodes,
    message: "New recovery codes generated. Save them in a safe place.",
  });
};
