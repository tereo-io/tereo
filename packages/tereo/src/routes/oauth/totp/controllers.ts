import { getDefaultOrganizationId } from "../../../utils/defaultOrganization.js";
import { handlePostAuthOrgSelection } from "../../../utils/orgSelection.js";
import { recordSessionsRevoked } from "../../../utils/sessionEvents.js";
import { issueKnownDevice } from "../../../utils/knownDevice.js";
import { totpFailure } from "../../../middleware/rateLimit.js";
import { logAuditTx, emitTx } from "../../../utils/outbox.js";
import { endUserSessions } from "../../../utils/sessions.js";
import { validateBody } from "../../../utils/validateReq.js";
import { OAuth2Error } from "../../../utils/errors.js";
import { logger } from "../../../utils/logger.js";
import type { Request, Response } from "express";
import db from "../../../utils/db/index.js";
import env from "../../../env.js";
import {
  clearTotpSessionCookie,
  getTotpSessionFromCookie,
  clearTotpSetupGrantCookie,
  getTotpSetupGrantFromCookie,
} from "../../../utils/cookies.js";
import {
  verifyTotpCode,
  verifyRecoveryCode,
  decryptTotpSecret,
  generateTotpSecret,
  generateTotpUri,
  generateTotpSetupToken,
  encryptTotpSecret,
  generateRecoveryCodes,
  assertTotpSetupAllowed,
  hashTotpSetupGrant,
} from "../../../utils/totp.js";
import {
  TotpVerifySchema,
  TotpRecoverySchema,
  TotpSetupInitiateSchema,
  TotpSetupVerifySchema,
} from "./schemas.js";

export const totpVerifyHandler = async (req: Request, res: Response) => {
  const body = validateBody(TotpVerifySchema, req);

  const verification = await db.totp.getVerificationSession(body.session_token);
  if (!verification) {
    throw new OAuth2Error(
      "invalid_session",
      "Session not found. Please login again."
    );
  }

  const client = await db.clients.get(verification.clientId);
  const sessionCookie = getTotpSessionFromCookie(req, client.clientId);
  if (!sessionCookie || sessionCookie !== body.session_token) {
    throw new OAuth2Error(
      "invalid_session",
      "Invalid or expired session. Please login again."
    );
  }

  if (verification.expiresAt < new Date()) {
    await db.totp.deleteVerificationSession(verification.id);
    clearTotpSessionCookie(res, client.clientId);
    throw new OAuth2Error(
      "session_expired",
      "Session expired. Please login again."
    );
  }

  await totpFailure.check(req, verification.userId);

  const encryptedSecret = await db.totp.getUserTotpSecret(verification.userId);
  if (!encryptedSecret) {
    throw new OAuth2Error(
      "totp_not_configured",
      "TOTP is not configured for this user."
    );
  }

  const secret = decryptTotpSecret(encryptedSecret);
  const step = verifyTotpCode(secret, body.totp_code);

  // A code is good once: a replay, even within its 30 seconds, fails here.
  if (
    step === null ||
    !(await db.totp.claimTotpWindow(verification.userId, step))
  ) {
    logger.warn(
      {
        userId: verification.userId,
        ip: req.ip,
      },
      "TOTP verification failed"
    );
    throw new OAuth2Error(
      "invalid_code",
      "Invalid verification code. Please try again.",
      401
    );
  }

  await totpFailure.reset(req, verification.userId);

  // One code, one login: a concurrent request with the same session loses.
  // The session is consumed where the next step is written, so a password
  // change cannot end it between the two and leave that step behind.
  const writeStep = db.loginFlows.writeStepConsuming(
    verification.userId,
    async (tx) => {
      if (!(await db.totp.consumeVerificationSession(verification.id, tx))) {
        throw new OAuth2Error(
          "invalid_session",
          "Session not found. Please login again."
        );
      }
    }
  );
  const result = await handlePostAuthOrgSelection(
    req,
    res,
    verification.userId,
    client,
    verification.redirectUri,
    verification.scopes,
    verification.state || null,
    verification.codeChallenge,
    verification.codeChallengeMethod,
    verification.nonce || null,
    new Date(),
    verification.maxAge ?? null,
    verification.acrValues || null,
    verification.prompt || null,
    [...verification.firstFactor, "otp"],
    undefined,
    writeStep
  );
  clearTotpSessionCookie(res, client.clientId);
  issueKnownDevice(res, await db.users.get(verification.userId));

  logger.debug(
    {
      userId: verification.userId,
      ip: req.ip,
    },
    "TOTP verification successful"
  );

  res.json(result);
};

export const totpRecoveryHandler = async (req: Request, res: Response) => {
  const body = validateBody(TotpRecoverySchema, req);

  const verification = await db.totp.getVerificationSession(body.session_token);
  if (!verification) {
    throw new OAuth2Error(
      "invalid_session",
      "Session not found. Please login again."
    );
  }

  const client = await db.clients.get(verification.clientId);
  const sessionCookie = getTotpSessionFromCookie(req, client.clientId);
  if (!sessionCookie || sessionCookie !== body.session_token) {
    throw new OAuth2Error(
      "invalid_session",
      "Invalid or expired session. Please login again."
    );
  }

  if (verification.expiresAt < new Date()) {
    await db.totp.deleteVerificationSession(verification.id);
    clearTotpSessionCookie(res, client.clientId);
    throw new OAuth2Error(
      "session_expired",
      "Session expired. Please login again."
    );
  }

  await totpFailure.check(req, verification.userId);

  const recoveryCodes = await db.totp.getUnusedRecoveryCodes(
    verification.userId
  );
  if (recoveryCodes.length === 0) {
    throw new OAuth2Error(
      "no_recovery_codes",
      "No recovery codes available. Please contact an administrator."
    );
  }

  let matchedCode: { id: string; codeHash: string } | null = null;
  for (const code of recoveryCodes) {
    const isValid = await verifyRecoveryCode(body.recovery_code, code.codeHash);
    if (isValid) {
      matchedCode = code;
      break;
    }
  }

  if (!matchedCode) {
    logger.warn(
      {
        userId: verification.userId,
        ip: req.ip,
      },
      "Recovery code verification failed"
    );
    throw new OAuth2Error(
      "invalid_code",
      "Invalid recovery code. Please try again.",
      401
    );
  }

  // Both atomic, so neither the code nor the session serves two logins, and
  // in the transaction that writes the next step, as at the TOTP step.
  const writeStep = db.loginFlows.writeStepConsuming(
    verification.userId,
    async (tx) => {
      if (
        !(await db.totp.consumeVerificationSession(verification.id, tx)) ||
        !(await db.totp.claimRecoveryCode(matchedCode.id, tx))
      ) {
        throw new OAuth2Error(
          "invalid_session",
          "Session not found. Please login again."
        );
      }
      const u = await db.users.get(verification.userId, tx);
      await logAuditTx(tx, {
        auth: { userId: u.id, email: u.email },
        action: "UPDATE",
        entityType: "User",
        entityId: u.id,
        entityName: u.email,
        metadata: {
          action: "recovery_code_used",
          recoveryCodesRemaining: recoveryCodes.length - 1,
        },
      });
    }
  );
  const result = await handlePostAuthOrgSelection(
    req,
    res,
    verification.userId,
    client,
    verification.redirectUri,
    verification.scopes,
    verification.state || null,
    verification.codeChallenge,
    verification.codeChallengeMethod,
    verification.nonce || null,
    new Date(),
    verification.maxAge ?? null,
    verification.acrValues || null,
    verification.prompt || null,
    [...verification.firstFactor, "recovery"],
    undefined,
    writeStep
  );
  clearTotpSessionCookie(res, client.clientId);
  await totpFailure.reset(req, verification.userId);
  issueKnownDevice(res, await db.users.get(verification.userId));

  logger.debug(
    {
      userId: verification.userId,
      ip: req.ip,
      recoveryCodesRemaining: recoveryCodes.length - 1,
    },
    "Recovery code used successfully"
  );

  res.json(result);
};

export const totpSetupInitiateHandler = async (req: Request, res: Response) => {
  const body = validateBody(TotpSetupInitiateSchema, req);
  await assertTotpSetupAllowed();

  const grant = await db.totp.getSetupGrant(
    hashTotpSetupGrant(body.setup_grant)
  );
  if (!grant) {
    throw new OAuth2Error(
      "invalid_setup_grant",
      "Invalid or expired setup link. Please login again."
    );
  }

  const client = await db.clients.get(grant.clientId);
  // The cookie is set alongside the grant, so a grant lifted from a URL is
  // useless outside the browser that passed the password check.
  if (getTotpSetupGrantFromCookie(req, client.clientId) !== body.setup_grant) {
    throw new OAuth2Error(
      "invalid_setup_grant",
      "Invalid or expired setup link. Please login again."
    );
  }

  // The grant is consumed where the setup session is written, so a password
  // change cannot end it between the two and leave the setup behind.
  const writeStep = db.loginFlows.writeStepConsuming(
    grant.userId,
    async (tx) => {
      if (!(await db.totp.consumeSetupGrant(grant.id, tx))) {
        throw new OAuth2Error(
          "invalid_setup_grant",
          "Invalid or expired setup link. Please login again."
        );
      }
    }
  );

  if (grant.expiresAt < new Date()) {
    await db.totp.consumeSetupGrant(grant.id);
    clearTotpSetupGrantCookie(res, client.clientId);
    throw new OAuth2Error(
      "setup_expired",
      "Setup link expired. Please login again."
    );
  }

  const user = await db.users.get(grant.userId);
  if (user.totpEnabled) {
    await db.totp.consumeSetupGrant(grant.id);
    clearTotpSetupGrantCookie(res, client.clientId);
    throw new OAuth2Error(
      "totp_already_enabled",
      "TOTP is already enabled for this account."
    );
  }

  const secret = generateTotpSecret();
  const setupToken = generateTotpSetupToken();
  const expiresAt = new Date(Date.now() + env.TOTP_SETUP_TTL * 1000);

  await writeStep((tx) =>
    db.totp.createSetupSession(
      {
        userId: user.id,
        setupToken,
        totpSecret: encryptTotpSecret(secret),
        expiresAt,
        clientId: client.id,
        redirectUri: grant.redirectUri,
        state: grant.state ?? undefined,
        scope: grant.scopes.join(" "),
        codeChallenge: grant.codeChallenge,
        codeChallengeMethod: grant.codeChallengeMethod,
        nonce: grant.nonce,
        maxAge: grant.maxAge,
        acrValues: grant.acrValues,
        prompt: grant.prompt,
      },
      tx
    )
  );
  clearTotpSetupGrantCookie(res, client.clientId);

  const qrCodeUri = generateTotpUri({
    issuer: env.TOTP_ISSUER,
    accountName: user.email,
    secret,
  });

  logger.debug(
    {
      userId: user.id,
      clientId: client.clientId,
    },
    "TOTP setup initiated during OAuth flow"
  );

  res.json({
    secret,
    qrCodeUri,
    setupToken,
    expiresAt: expiresAt.toISOString(),
  });
};

export const totpSetupVerifyHandler = async (req: Request, res: Response) => {
  const body = validateBody(TotpSetupVerifySchema, req);
  await assertTotpSetupAllowed();

  const setupSession = await db.totp.getSetupSession(body.setup_token);
  // One begun from the account page belongs to a signed-in token, which only
  // the account route checks.
  if (!setupSession || setupSession.clientId === null) {
    throw new OAuth2Error(
      "invalid_setup_token",
      "Invalid or expired setup token. Please start again."
    );
  }

  if (setupSession.expiresAt < new Date()) {
    await db.totp.deleteSetupSession(setupSession.id);
    throw new OAuth2Error(
      "setup_expired",
      "Setup session expired. Please start again."
    );
  }

  await totpFailure.check(req, setupSession.userId);

  const secret = decryptTotpSecret(setupSession.totpSecret);
  const step = verifyTotpCode(secret, body.totp_code);
  if (step === null) {
    throw new OAuth2Error(
      "invalid_code",
      "Invalid verification code. Please try again.",
      401
    );
  }
  await totpFailure.reset(req, setupSession.userId);

  const encryptedSecret = encryptTotpSecret(secret);

  const settings = await db.settings.getTotpSettings();
  const { plainCodes, hashedCodes } = await generateRecoveryCodes(
    settings.totpRecoveryCodeCount
  );

  // As at the account route: sessions opened with the password alone,
  // possibly an attacker's, must not outlive the switch to 2FA. The login
  // that enrolled restarts at /oauth/authorize afterwards, so loses nothing.
  const user = await db.users.get(setupSession.userId);
  const actor = { userId: user.id, email: user.email };
  const recordRevoked = recordSessionsRevoked(actor, user, { self: true });
  await endUserSessions(
    user.id,
    null,
    async (tx, sessionIds, ssoSessionIds) => {
      if (!(await db.totp.enableTotp(user.id, encryptedSecret, step, tx))) {
        throw new OAuth2Error(
          "invalid_code",
          "Invalid verification code. Please try again.",
          401
        );
      }
      await db.totp.storeRecoveryCodes(user.id, hashedCodes, tx);
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

  logger.debug(
    {
      userId: setupSession.userId,
    },
    "User completed TOTP setup during OAuth flow"
  );

  res.json({
    success: true,
    recoveryCodes: plainCodes,
    message:
      "TOTP enabled successfully. Save your recovery codes in a safe place.",
  });
};
