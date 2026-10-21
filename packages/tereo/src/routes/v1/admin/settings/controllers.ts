import { getDefaultOrganizationId } from "../../../../utils/defaultOrganization.js";
import { disconnectTokenSockets } from "../../../../websocket/emitters/index.js";
import type { TotpPolicy } from "../../../../utils/db/settings.js";
import { assertGlobalAdmin } from "../../../../utils/grants.js";
import { validateBody } from "../../../../utils/validateReq.js";
import { OAuth2Error } from "../../../../utils/errors.js";
import { validateUser } from "../../../../utils/auth.js";
import { logger } from "../../../../utils/logger.js";
import { UpdateSettingsSchema } from "./schemas.js";
import type { Request, Response } from "express";
import db from "../../../../utils/db/index.js";
import {
  computeChanges,
  emitTx,
  logAuditTx,
} from "../../../../utils/outbox.js";

const POLICY_STRENGTH: Record<TotpPolicy, number> = {
  disabled: 0,
  optional: 1,
  required: 2,
};

export const getSettings = async (_req: Request, res: Response) => {
  const settings = await db.settings.getTotpSettings();

  res.json({
    totpPolicy: settings.totpPolicy,
    totpRecoveryCodeCount: settings.totpRecoveryCodeCount,
  });
};

export const updateSettings = async (req: Request, res: Response) => {
  const auth = validateUser(req);
  const body = validateBody(UpdateSettingsSchema, req);

  if (Object.keys(body).length === 0) {
    throw new OAuth2Error("invalid_request", "No settings to update");
  }

  const { updatedSettings, revokedJtis } = await db.$transaction(async (tx) => {
    // A relaxation is judged against the policy it replaces, which no
    // concurrent change may move in between.
    await db.settings.lockTotpSettings(tx);
    const existing = await db.settings.getTotpSettings(tx);
    const next = body.totpPolicy ?? existing.totpPolicy;
    const change = POLICY_STRENGTH[next] - POLICY_STRENGTH[existing.totpPolicy];
    // `disabled` overrides every role's requires2fa, admin's included, so
    // no narrower permission bounds it.
    if (change < 0) {
      await assertGlobalAdmin(
        auth,
        "Only an administrator (global admin) can relax the two-factor policy",
        tx
      );
    }
    const updated = await db.settings.updateTotpSettings(body, tx);
    // Permissions are read live, so a token from a password-only login
    // would keep working under the stricter policy; revoked, its refresh
    // meets the step-up. `optional` newly requires 2FA only of holders of
    // a role that requires it.
    const revokedJtis =
      change > 0
        ? await db.accessTokens.revokeWithoutMfa(
            next === "required"
              ? {}
              : { userRoles: { some: { role: { requires2fa: true } } } },
            tx
          )
        : [];
    await logAuditTx(tx, {
      auth,
      action: "UPDATE",
      entityType: "SystemSettings",
      entityId: "totp",
      entityName: "TOTP settings",
      changes: computeChanges({ ...existing }, { ...updated }),
      ...(revokedJtis.length > 0 && {
        metadata: { accessTokensRevoked: revokedJtis.length },
      }),
    });
    await emitTx(tx, {
      organizationId: getDefaultOrganizationId(),
      eventType: "auth.settings.updated",
      entityType: "SystemSettings",
      entityId: "totp",
      data: {
        totpPolicy: updated.totpPolicy,
        totpRecoveryCodeCount: updated.totpRecoveryCodeCount,
      },
    });
    return { updatedSettings: updated, revokedJtis };
  });

  disconnectTokenSockets(revokedJtis);

  logger.debug(
    {
      adminId: auth.userId,
      changes: body,
    },
    "Settings updated"
  );

  res.json({
    totpPolicy: updatedSettings.totpPolicy,
    totpRecoveryCodeCount: updatedSettings.totpRecoveryCodeCount,
  });
};
